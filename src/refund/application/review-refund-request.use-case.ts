import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { MetricsService } from "@src/metrics/metrics.service";
import { NotificationService } from "@src/notification/notification.service";
import { PaymentService } from "@src/payment/payment.service";
import { QueueService } from "@src/queue/queue.service";
import { PromotionService } from "@src/promotion/promotion.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import {
  RefundProvider,
  RefundRequestStatus,
} from "@src/schemas/refund-request.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Zone } from "@src/schemas/zone.schema";
import { ZoneService } from "@src/zone/zone.service";
import { Connection, Model, Types } from "mongoose";
import { ReviewRefundRequestDto } from "../dto/review-refund-request.dto";
import { RefundPolicyService } from "../domain/policies/refund-policy.service";
import {
  RefundableBooking,
  RefundRequestDocument,
} from "../domain/types/refund-domain.types";
import { RefundRepository } from "../infrastructure/persistence/refund.repository";
import { RefundPresenter } from "../presenters/refund.presenter";
import type { RefundRequestDetail } from "../types/refund.types";

/**
 * Minimal, freshly-read-inside-the-transaction snapshot used only by
 * finalizeRefundedBooking()'s invariant checks below — deliberately not the
 * broader RefundableBooking type, since this read happens on a real
 * ClientSession and must select exactly the fields the invariant check and
 * zone-decrement math need, including `status` and `refundHistory` (neither
 * of which RefundableBooking's projection carries).
 */
type FinalizeBookingSnapshot = {
  status: BookingStatus;
  zoneId: Types.ObjectId;
  quantity: number;
  totalPrice: number;
  totalRefunded?: number;
  refundHistory?: Array<{ refundRequestId?: Types.ObjectId }>;
};

@Injectable()
export class ReviewRefundRequestUseCase {
  private readonly logger = new Logger(ReviewRefundRequestUseCase.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly repository: RefundRepository,
    private readonly policy: RefundPolicyService,
    private readonly presenter: RefundPresenter,
    private readonly paymentService: PaymentService,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService,
    private readonly metricsService: MetricsService,
    private readonly zoneService: ZoneService,
    private readonly queueService: QueueService,
    private readonly promotionService: PromotionService
  ) {}

  async approve(
    user: JwtPayload,
    id: string,
    dto: ReviewRefundRequestDto
  ): Promise<RefundRequestDetail> {
    const request = await this.repository.loadRequestById(id);
    await this.policy.assertCanReview(user, request.eventId.toString());
    if (request.status !== RefundRequestStatus.REQUESTED) {
      throw new ConflictException("Only requested refunds can be approved");
    }

    await this.moveToProcessing(request._id, user, [
      RefundRequestStatus.REQUESTED,
    ]);
    return this.executeRefund(request, user, dto.reason ?? "Refund approved");
  }

  async reject(
    user: JwtPayload,
    id: string,
    dto: ReviewRefundRequestDto
  ): Promise<RefundRequestDetail> {
    const request = await this.repository.loadRequestById(id);
    await this.policy.assertCanReview(user, request.eventId.toString());
    if (
      ![RefundRequestStatus.REQUESTED, RefundRequestStatus.FAILED].includes(
        request.status
      )
    ) {
      throw new ConflictException(
        "Only requested or failed refunds can be rejected"
      );
    }

    const updated = await this.repository.conditionalUpdateRequest(
      {
        _id: request._id,
        status: {
          $in: [RefundRequestStatus.REQUESTED, RefundRequestStatus.FAILED],
        },
      },
      {
        $set: {
          status: RefundRequestStatus.REJECTED,
          reviewedBy: new Types.ObjectId(user.userId),
          reviewedAt: new Date(),
          failureReason: dto.reason ?? "Refund rejected",
        },
      }
    );

    const row = this.assertUpdated(updated);
    await this.auditService.record({
      action: AuditAction.REFUND_REJECTED,
      actorId: user.userId,
      actorRole: user.role,
      bookingId: row.bookingId.toString(),
      eventId: row.eventId.toString(),
      reason: dto.reason,
      metadata: { amount: row.amount },
    });

    await this.notificationService.notifyRefundReviewed({
      userId: row.userId,
      bookingId: row.bookingId.toString(),
      bookingCode: this.getBookingCodeFromRequest(row),
      eventId: row.eventId.toString(),
      refundRequestId: row._id.toString(),
      approved: false,
      amount: row.amount,
    });

    return this.presenter.toDetail(row);
  }

  async retry(user: JwtPayload, id: string): Promise<RefundRequestDetail> {
    const request = await this.repository.loadRequestById(id);
    await this.policy.assertCanReview(user, request.eventId.toString());
    if (request.status !== RefundRequestStatus.FAILED) {
      throw new ConflictException(
        "Only failed refunds can be retried. A refund stuck in reconciliation must use the reconcile endpoint instead — it must not re-issue a second provider refund."
      );
    }

    await this.moveToProcessing(request._id, user, [
      RefundRequestStatus.REQUESTED,
      RefundRequestStatus.FAILED,
    ]);
    await this.auditService.record({
      action: AuditAction.REFUND_RETRY,
      actorId: user.userId,
      actorRole: user.role,
      bookingId: request.bookingId.toString(),
      eventId: request.eventId.toString(),
      metadata: { amount: request.amount },
    });

    return this.executeRefund(request, user, "Refund retry");
  }

  /**
   * Resumes a request stuck in RECONCILIATION_REQUIRED (see NEW#3 in
   * production-readiness-audit-2026-07-22.md): the provider refund already
   * succeeded — money already moved — but the DB finalize step (cancel
   * booking/tickets, release zone inventory, mark this request SUCCEEDED)
   * failed before committing. MUST NOT call paymentService.issueAdminRefund
   * again — that would risk a second, real provider refund for money that
   * was already returned. Only re-attempts the DB-side finalize, which is
   * safe to re-run: finalizeRefundedBooking only treats the booking as
   * already-committed when its refundHistory carries an entry tagged with
   * THIS refund request's id — a booking that left CONFIRMED for any other
   * reason (e.g. a concurrent admin-cancel-booking/cancel-ticket race) is
   * NOT treated as done and re-raises RECONCILIATION_REQUIRED instead of a
   * false SUCCEEDED.
   */
  async reconcile(user: JwtPayload, id: string): Promise<RefundRequestDetail> {
    const request = await this.repository.loadRequestById(id);
    await this.policy.assertCanReview(user, request.eventId.toString());
    if (request.status !== RefundRequestStatus.RECONCILIATION_REQUIRED) {
      throw new ConflictException(
        "Only refunds awaiting reconciliation can be reconciled"
      );
    }
    const provider = request.provider;
    const providerRefundId = request.providerRefundId;
    if (!provider || !providerRefundId) {
      // Durability guarantee this method depends on: recordReconciliationRequired()
      // always persists provider/providerRefundId before this status is ever set.
      throw new ConflictException(
        "Refund request is missing provider refund evidence and cannot be safely reconciled"
      );
    }

    await this.moveToProcessing(request._id, user, [
      RefundRequestStatus.RECONCILIATION_REQUIRED,
    ]);

    const booking = await this.repository.loadBookingById(
      request.bookingId.toString()
    );
    const isFullRefund = this.isFullRefund(booking, request.amount);

    try {
      await this.finalizeRefundedBooking(
        booking,
        user,
        "Refund reconciliation completed",
        request.amount,
        isFullRefund,
        request._id
      );
    } catch (error) {
      await this.recordReconciliationRequired(
        request,
        user,
        provider,
        providerRefundId,
        error
      );
      throw error;
    }

    if (isFullRefund) {
      await this.zoneService.invalidateZoneAvailabilityCache(booking.zoneId);
    }

    return this.finalizeSucceededRequest(
      request,
      user,
      booking,
      "Refund reconciliation completed",
      provider,
      providerRefundId
    );
  }

  private isFullRefund(booking: RefundableBooking, amount: number): boolean {
    // Same amount → refundable-balance comparison RefundPolicyService uses
    // at create time, recomputed here against the current booking so it
    // reflects any refund that has landed since the request was created.
    const refundableBalance = booking.totalPrice - (booking.totalRefunded ?? 0);
    return amount >= refundableBalance;
  }

  private async executeRefund(
    request: RefundRequestDocument,
    reviewer: JwtPayload,
    reason: string
  ): Promise<RefundRequestDetail> {
    const booking = await this.repository.loadBookingById(
      request.bookingId.toString()
    );
    this.policy.assertBookingRefundableForReview(booking);

    const isFullRefund = this.isFullRefund(booking, request.amount);

    await this.bookingModel.updateOne(
      {
        _id: booking._id,
        paymentStatus: PaymentStatus.PAID,
        status: BookingStatus.CONFIRMED,
        isDeleted: false,
      },
      { $set: { paymentStatus: PaymentStatus.REFUND_PENDING } }
    );

    const result = await this.paymentService.issueAdminRefund(
      booking._id.toString(),
      booking.stripePaymentIntentId,
      reviewer.userId,
      reason,
      {
        partialAmountVnd: isFullRefund ? undefined : request.amount,
        // Unique per refund REQUEST (not per booking): retries of this same
        // request must reuse the same provider idempotency key, but a
        // second, separate partial refund request against the same booking
        // must NOT collide with the first one's key.
        idempotencyReference: request._id.toString(),
      }
    );

    if (result.status === "failed") {
      return this.handleProviderFailure(request, reviewer, booking, result);
    }

    // From this point on, the provider has ALREADY moved money — every
    // failure branch below MUST durably record that fact (rule.md 3.5:
    // never let a post-provider-success failure look like nothing happened)
    // instead of letting the request stay silently stuck at PROCESSING.
    const provider = result.provider as RefundProvider;
    try {
      await this.finalizeRefundedBooking(
        booking,
        reviewer,
        reason,
        request.amount,
        isFullRefund,
        request._id
      );
    } catch (error) {
      await this.recordReconciliationRequired(
        request,
        reviewer,
        provider,
        result.providerRefundId,
        error
      );
      throw error;
    }

    if (isFullRefund) {
      await this.zoneService.invalidateZoneAvailabilityCache(booking.zoneId);
    }

    return this.finalizeSucceededRequest(
      request,
      reviewer,
      booking,
      reason,
      provider,
      result.providerRefundId
    );
  }

  /**
   * Shared tail for both the first-attempt success path (executeRefund) and
   * the reconciliation-resume success path (reconcile): marks the request
   * SUCCEEDED, audits, and notifies the customer. Only reached once
   * finalizeRefundedBooking has actually committed.
   */
  private async finalizeSucceededRequest(
    request: RefundRequestDocument,
    reviewer: JwtPayload,
    booking: RefundableBooking,
    reason: string,
    provider: RefundProvider,
    providerRefundId: string | undefined
  ): Promise<RefundRequestDetail> {
    const succeeded = await this.repository.updateRequestById(request._id, {
      $set: {
        status: RefundRequestStatus.SUCCEEDED,
        provider,
        providerRefundId,
        reviewedBy: new Types.ObjectId(reviewer.userId),
        reviewedAt: new Date(),
      },
      $unset: { failureReason: "" },
    });

    await this.auditService.record({
      action: AuditAction.REFUND_APPROVED,
      actorId: reviewer.userId,
      actorRole: reviewer.role,
      bookingId: request.bookingId.toString(),
      eventId: request.eventId.toString(),
      reason,
      metadata: {
        amount: request.amount,
        provider,
        providerRefundId: providerRefundId ?? null,
      },
    });

    await this.notificationService.notifyRefundReviewed({
      userId: request.userId,
      bookingId: request.bookingId.toString(),
      bookingCode: booking.bookingCode,
      eventId: request.eventId.toString(),
      refundRequestId: request._id.toString(),
      approved: true,
      amount: request.amount,
    });

    return this.presenter.toDetail(this.assertUpdated(succeeded));
  }

  /**
   * Durable recovery record for "provider refund succeeded, DB finalize
   * failed" (NEW#3 / PRE-3 cluster). Persists provider/providerRefundId so
   * reconcile() never has to guess what already happened at the provider,
   * fires a MONEY_RISK log for on-call, and increments the same
   * refund-failure metric issue-admin-refund.use-case.ts uses (labelled
   * "finalize" to distinguish from a provider-side failure).
   */
  private async recordReconciliationRequired(
    request: RefundRequestDocument,
    reviewer: JwtPayload,
    provider: RefundProvider,
    providerRefundId: string | undefined,
    error: unknown
  ): Promise<void> {
    const errorMessage = getErrorMessage(error);
    this.logger.error(
      `[MONEY_RISK] Provider refund succeeded (provider=${provider}, providerRefundId=${providerRefundId ?? "unknown"}) ` +
        `but DB finalize FAILED for refundRequestId=${request._id.toString()}, bookingId=${request.bookingId.toString()}. ` +
        `Manual reconciliation required via POST /refund-requests/${request._id.toString()}/reconcile. Error: ${errorMessage}`,
      { alert: "MONEY_RISK" }
    );
    this.metricsService.refundFailuresTotal.inc({ source: "finalize" });

    await this.repository.updateRequestById(request._id, {
      $set: {
        status: RefundRequestStatus.RECONCILIATION_REQUIRED,
        provider,
        providerRefundId,
        reviewedBy: new Types.ObjectId(reviewer.userId),
        reviewedAt: new Date(),
        failureReason: `DB finalize failed after provider refund succeeded: ${errorMessage}`,
      },
    });

    await this.auditService.record({
      action: AuditAction.REFUND_RECONCILIATION_REQUIRED,
      actorId: reviewer.userId,
      actorRole: reviewer.role,
      bookingId: request.bookingId.toString(),
      eventId: request.eventId.toString(),
      reason: errorMessage,
      metadata: {
        amount: request.amount,
        provider,
        providerRefundId: providerRefundId ?? null,
      },
    });

    await this.enqueueReconciliationAlert(
      request,
      provider,
      providerRefundId,
      errorMessage
    );
  }

  private toAlertSource(provider: RefundProvider): "stripe" | "paypal" {
    return provider === RefundProvider.STRIPE ? "stripe" : "paypal";
  }

  /**
   * Reuses the same "refund-failure-alert" queue job/email path
   * issue-admin-refund.use-case.ts's enqueueRefundFailureAlert already
   * delivers to ALERT_EMAIL — without this, RECONCILIATION_REQUIRED (money
   * already moved, DB finalize failed) was only discoverable via a log line
   * and an unwatched Prometheus counter, unlike the less-dangerous
   * "provider call itself failed" sibling path, which already pages
   * someone. Enqueue failure is a non-critical side effect here (rule.md
   * 3.5): the status/audit/metric above are already durably recorded
   * regardless of whether this succeeds.
   */
  private async enqueueReconciliationAlert(
    request: RefundRequestDocument,
    provider: RefundProvider,
    providerRefundId: string | undefined,
    errorMessage: string
  ): Promise<void> {
    try {
      await this.queueService.addJob({
        type: "refund-failure-alert",
        payload: {
          bookingId: request.bookingId.toString(),
          paymentRef: providerRefundId ?? "unknown",
          source: this.toAlertSource(provider),
          errorMessage: `DB finalize failed after provider refund succeeded (refundRequestId=${request._id.toString()}): ${errorMessage}`,
          occurredAt: new Date().toISOString(),
        },
      });
    } catch (alertErr) {
      this.logger.error(
        `[ALERT_ENQUEUE_FAILED] Could not enqueue reconciliation alert for refundRequestId=${request._id.toString()}: ${getErrorMessage(alertErr)}`
      );
    }
  }

  private async handleProviderFailure(
    request: RefundRequestDocument,
    reviewer: JwtPayload,
    booking: RefundableBooking,
    result: Awaited<ReturnType<PaymentService["issueAdminRefund"]>>
  ): Promise<RefundRequestDetail> {
    const failureReason = result.errorMessage ?? "Refund provider failed";
    const failed = await this.repository.updateRequestById(request._id, {
      $set: {
        status: RefundRequestStatus.FAILED,
        provider: result.provider,
        failureReason,
      },
    });

    await this.auditService.record({
      action: AuditAction.REFUND_FAILED,
      actorId: reviewer.userId,
      actorRole: reviewer.role,
      bookingId: request.bookingId.toString(),
      eventId: request.eventId.toString(),
      reason: failureReason,
      metadata: { amount: request.amount, provider: result.provider },
    });

    await this.notificationService.notifyRefundFailed({
      userId: request.userId,
      bookingId: request.bookingId.toString(),
      bookingCode: booking.bookingCode,
      eventId: request.eventId.toString(),
      refundRequestId: request._id.toString(),
      amount: request.amount,
      reason: failureReason,
    });

    return this.presenter.toDetail(this.assertUpdated(failed));
  }

  /**
   * A refund that exhausts the booking's remaining refundable balance
   * cancels the booking, its valid tickets, and releases the zone's sold
   * counters — the customer received all their money back, so the booking
   * is void. A refund that does NOT exhaust the balance (a true partial
   * refund, VND-Stripe only — see RefundPolicyService.resolveRefundAmount)
   * is a pure monetary adjustment: the booking stays CONFIRMED/PAID and its
   * tickets stay valid, only `totalRefunded`/`refundHistory` change. This
   * distinction did not exist before rule.md's bug-fix pass: previously
   * ANY approved refund (even a 1-VND partial one) fully cancelled the
   * booking and every ticket on it, which contradicted the very existence
   * of `totalRefunded`/`refundHistory` as accumulating fields meant to
   * support more than one refund per booking over time.
   */
  private async finalizeRefundedBooking(
    booking: RefundableBooking,
    reviewer: JwtPayload,
    reason: string,
    amount: number,
    isFullRefund: boolean,
    refundRequestId: Types.ObjectId
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        // Re-read fresh, unfiltered by status, INSIDE the transaction:
        // provider money has already moved by the time this runs, so we
        // must be able to tell "already committed" apart from "left
        // CONFIRMED for an unrelated reason" instead of just checking
        // existence against a status filter (rule.md 2.2/3.4/12 — the old
        // `findOne({status: CONFIRMED})` returning null was indistinguishable
        // from either case, and silently treating both as "done" is exactly
        // the bug this fixes).
        const current = await this.bookingModel
          .findOne({ _id: booking._id, isDeleted: false })
          .select(
            "status zoneId quantity totalPrice totalRefunded refundHistory"
          )
          .session(session)
          .lean<FinalizeBookingSnapshot>();

        if (!current) {
          throw new Error(
            `finalizeRefundedBooking: booking ${booking._id.toString()} not found (deleted?) after provider refund succeeded for refundRequestId=${refundRequestId.toString()} — cannot verify finalize state, manual reconciliation required`
          );
        }

        // Positive idempotency check: did THIS refund request already
        // commit its finalize write in a prior attempt (e.g. withTransaction
        // reported an ambiguous/ retried commit and reconcile() re-ran)?
        // Only this is safe to treat as a true no-op.
        const alreadyCommitted = (current.refundHistory ?? []).some((entry) =>
          entry.refundRequestId?.equals(refundRequestId)
        );
        if (alreadyCommitted) {
          return;
        }

        if (current.status !== BookingStatus.CONFIRMED) {
          // Booking left CONFIRMED for a reason THIS refund attempt did not
          // cause — e.g. a concurrent admin-cancel-booking/cancel-ticket
          // flow raced this approval — and this specific request never
          // recorded its refundHistory entry. Provider money has already
          // moved; silently returning here would let the caller mark this
          // request SUCCEEDED with inventory/bookkeeping never applied.
          // Throwing routes the caller into recordReconciliationRequired
          // instead (rule.md 3.5/4.4: no false success after a partial
          // failure).
          throw new Error(
            `finalizeRefundedBooking: booking ${booking._id.toString()} is "${current.status}", not CONFIRMED, and has no refundHistory entry for refundRequestId=${refundRequestId.toString()} — booking state changed concurrently while this refund's provider call was in flight, manual reconciliation required`
          );
        }

        if (!isFullRefund) {
          await this.bookingModel.updateOne(
            { _id: booking._id },
            {
              $set: { paymentStatus: PaymentStatus.PAID },
              $inc: { totalRefunded: amount },
              $push: {
                refundHistory: {
                  amount,
                  refundedAt: new Date(),
                  refundRequestId,
                },
              },
            },
            { session }
          );
          return;
        }

        await this.bookingModel.updateOne(
          { _id: booking._id },
          {
            $set: {
              status: BookingStatus.CANCELLED,
              paymentStatus: PaymentStatus.REFUNDED,
              cancelledAt: new Date(),
              cancelledBy: new Types.ObjectId(reviewer.userId),
              cancellationReason: reason,
            },
            $inc: { totalRefunded: amount },
            $push: {
              refundHistory: {
                amount,
                refundedAt: new Date(),
                refundRequestId,
              },
            },
          },
          { session }
        );

        await this.ticketModel.updateMany(
          { bookingId: booking._id, status: "valid", isDeleted: false },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date(),
              cancelledBy: new Types.ObjectId(reviewer.userId),
            },
          },
          { session }
        );

        await this.zoneModel.updateOne(
          { _id: current.zoneId },
          [
            {
              $set: {
                soldCount: {
                  $max: [{ $subtract: ["$soldCount", current.quantity] }, 0],
                },
                confirmedSoldCount: {
                  $max: [
                    { $subtract: ["$confirmedSoldCount", current.quantity] },
                    0,
                  ],
                },
              },
            },
          ],
          { session }
        );

        // Full refund cancels the booking entirely — any promo redemption
        // tied to it must be released in the same transaction, or quota
        // stays leaked/held for a booking that no longer has any valid
        // entitlement. Idempotent (guarded by releasedAt), so replaying this
        // transaction on retry/reconcile never double-releases.
        await this.promotionService.releaseUsageForBooking(
          booking._id as Types.ObjectId,
          session
        );
      });
    } finally {
      // A cleanup failure here does NOT mean the transaction didn't commit
      // (withTransaction already resolved above) — must not let it look
      // like a finalize failure to the caller's try/catch (rule.md 3.5:
      // avoid false failure after a successful commit).
      await session.endSession().catch((error: unknown) => {
        this.logger.warn(
          `finalizeRefundedBooking: session.endSession failed for bookingId=${booking._id.toString()} (transaction outcome unaffected) — ${getErrorMessage(error)}`
        );
      });
    }
  }

  private async moveToProcessing(
    requestId: Types.ObjectId,
    reviewer: JwtPayload,
    fromStatuses: RefundRequestStatus[]
  ): Promise<void> {
    const updated = await this.repository.updateRequestStatus(
      requestId,
      { $in: fromStatuses },
      {
        $set: {
          status: RefundRequestStatus.PROCESSING,
          reviewedBy: new Types.ObjectId(reviewer.userId),
          reviewedAt: new Date(),
        },
        $unset: { failureReason: "" },
      }
    );

    if (updated.modifiedCount !== 1) {
      throw new ConflictException("Refund request status changed");
    }
  }

  private getBookingCodeFromRequest(row: RefundRequestDocument): string {
    const bookingCode = row.metadata?.bookingCode;
    return typeof bookingCode === "string"
      ? bookingCode
      : row.bookingId.toString();
  }

  private assertUpdated(
    row: RefundRequestDocument | null
  ): RefundRequestDocument {
    if (!row) {
      throw new ConflictException("Refund request status changed");
    }
    return row;
  }
}
