import { ConflictException, Injectable } from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { NotificationService } from "@src/notification/notification.service";
import { PaymentService } from "@src/payment/payment.service";
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

@Injectable()
export class ReviewRefundRequestUseCase {
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
    private readonly notificationService: NotificationService
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

    await this.moveToProcessing(request._id, user);
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
      throw new ConflictException("Only failed refunds can be retried");
    }

    await this.moveToProcessing(request._id, user);
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

  private async executeRefund(
    request: RefundRequestDocument,
    reviewer: JwtPayload,
    reason: string
  ): Promise<RefundRequestDetail> {
    const booking = await this.repository.loadBookingById(
      request.bookingId.toString()
    );
    this.policy.assertBookingRefundableForReview(booking);

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
      reason
    );

    if (result.status === "failed") {
      return this.handleProviderFailure(request, reviewer, booking, result);
    }

    await this.finalizeRefundedBooking(
      booking,
      reviewer,
      reason,
      request.amount
    );
    const succeeded = await this.repository.updateRequestById(request._id, {
      $set: {
        status: RefundRequestStatus.SUCCEEDED,
        provider: result.provider as RefundProvider,
        providerRefundId: result.providerRefundId,
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
        provider: result.provider,
        providerRefundId: result.providerRefundId ?? null,
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

  private async finalizeRefundedBooking(
    booking: RefundableBooking,
    reviewer: JwtPayload,
    reason: string,
    amount: number
  ): Promise<void> {
    const session = await this.connection.startSession();
    try {
      await session.withTransaction(async () => {
        const current = await this.bookingModel
          .findOne({
            _id: booking._id,
            status: BookingStatus.CONFIRMED,
            isDeleted: false,
          })
          .select("zoneId quantity totalPrice totalRefunded")
          .session(session)
          .lean<RefundableBooking>();

        if (!current) return;

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
            $push: { refundHistory: { amount, refundedAt: new Date() } },
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
      });
    } finally {
      await session.endSession();
    }
  }

  private async moveToProcessing(
    requestId: Types.ObjectId,
    reviewer: JwtPayload
  ): Promise<void> {
    const updated = await this.repository.updateRequestStatus(
      requestId,
      {
        $in: [RefundRequestStatus.REQUESTED, RefundRequestStatus.FAILED],
      },
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
