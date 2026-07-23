import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  PaymentGatewayService,
  paypalSdk,
} from "@src/payment/infrastructure/gateway/payment-gateway.service";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import { Booking, PaymentStatus } from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { MetricsService } from "@src/metrics/metrics.service";
import { QueueService } from "@src/queue/queue.service";
import { Model, Types } from "mongoose";
import type {
  AdminRefundOptions,
  AdminRefundResult,
} from "@src/payment/types/payment.types";

@Injectable()
export class IssueAdminRefundUseCase {
  private readonly logger = new Logger(IssueAdminRefundUseCase.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly queueService: QueueService,
    private readonly metricsService: MetricsService
  ) {}

  async execute(
    bookingId: string,
    stripePaymentIntentId: string | undefined,
    adminId: string,
    reason: string,
    options?: AdminRefundOptions
  ): Promise<AdminRefundResult> {
    if (stripePaymentIntentId) {
      return this.issueStripeRefund(
        bookingId,
        stripePaymentIntentId,
        adminId,
        reason,
        options
      );
    }

    if (options?.partialAmountVnd !== undefined) {
      // Enforced earlier at RefundPolicyService.resolveRefundAmount (create
      // time) too — repeated here because this is the actual money-movement
      // boundary and MUST NOT silently do a full refund when a partial one
      // was requested, regardless of what upstream validation did or didn't
      // catch (rule.md 5.3: re-check at the point that matters).
      throw new BadRequestException(
        "Partial refunds are not supported for PayPal payments"
      );
    }

    return this.issuePaypalRefund(
      bookingId,
      reason,
      options?.idempotencyReference
    );
  }

  private async issueStripeRefund(
    bookingId: string,
    stripePaymentIntentId: string,
    adminId: string,
    reason: string,
    options?: AdminRefundOptions
  ): Promise<AdminRefundResult> {
    const isFullRefund = options?.partialAmountVnd === undefined;
    try {
      const refund = await this.paymentGateway.stripe.refunds.create(
        {
          payment_intent: stripePaymentIntentId,
          // VND is a Stripe zero-decimal currency (see
          // create-checkout-session.use-case.ts's unit_amount), so this is
          // the raw integer value with no minor-unit conversion. Omitting
          // `amount` (full refund) lets Stripe refund whatever remains
          // un-refunded on the intent — the same behavior this call always
          // had before partial refunds existed.
          ...(isFullRefund
            ? {}
            : { amount: Math.round(options!.partialAmountVnd!) }),
          metadata: { reason, bookingId, adminId, source: "admin_cancel" },
        },
        {
          idempotencyKey: `admin-refund:${options?.idempotencyReference ?? bookingId}`,
        }
      );
      this.logger.log(
        `[REFUND] Stripe admin refund issued: bookingId=${bookingId}, pi=${stripePaymentIntentId}, full=${isFullRefund}`
      );
      await this.markBookingRefunded(bookingId, isFullRefund);
      await this.markPaymentRefunded(
        bookingId,
        "stripe",
        refund.id,
        refund.amount,
        isFullRefund
      );
      return {
        provider: "stripe",
        status: "succeeded",
        providerRefundId: refund.id,
      };
    } catch (err) {
      const errMsg = getPaymentErrorMessage(err);
      this.logger.error(
        `[CRITICAL] Stripe admin refund FAILED: bookingId=${bookingId}. MANUAL REFUND REQUIRED. Error: ${errMsg}`,
        { alert: "MONEY_RISK" }
      );
      await this.markBookingPaid(bookingId);
      await this.enqueueRefundFailureAlert(
        bookingId,
        stripePaymentIntentId,
        "stripe",
        errMsg
      );
      return { provider: "stripe", status: "failed", errorMessage: errMsg };
    }
  }

  private async issuePaypalRefund(
    bookingId: string,
    reason: string,
    idempotencyReference?: string
  ): Promise<AdminRefundResult> {
    const paymentDoc = await this.paymentModel
      .findOne({
        bookingId: new Types.ObjectId(bookingId),
        paymentMethod: "paypal",
        status: "succeeded",
        isDeleted: false,
      })
      .select("paypalCaptureId amount")
      .lean<{ paypalCaptureId?: string; amount?: number }>();

    if (!paymentDoc?.paypalCaptureId) {
      const errorMessage = "No refundable PayPal payment found";
      this.logger.warn(
        `issueAdminRefund: no refundable payment found for bookingId=${bookingId}`
      );
      await this.markBookingPaid(bookingId);
      return { provider: "paypal", status: "failed", errorMessage };
    }

    try {
      const refundRequest = new paypalSdk.payments.CapturesRefundRequest(
        paymentDoc.paypalCaptureId
      );
      refundRequest.requestBody({
        note_to_payer: reason || "Admin cancellation",
      });
      // Unique per refund REQUEST (mirrors issueStripeRefund's idempotencyKey
      // above) so a retry of the same admin refund request reuses the same
      // PayPal-Request-Id instead of risking a second live refund
      // (production-readiness-audit-2026-07-22.md PRE-6).
      refundRequest.payPalRequestId(
        `admin-refund:${idempotencyReference ?? bookingId}`
      );
      const refundResult = await this.paymentGateway.withPaypalTimeout(
        this.paymentGateway.paypalClient.execute(refundRequest)
      );
      const paypalRefundId = this.extractPaypalRefundId(refundResult.result);
      this.logger.log(
        `[REFUND] PayPal admin refund issued: bookingId=${bookingId}, captureId=${paymentDoc.paypalCaptureId}`
      );
      // PayPal refunds issued by this method are always full (partial is
      // rejected before reaching here).
      await this.markBookingRefunded(bookingId, true);
      await this.markPaymentRefunded(
        bookingId,
        "paypal",
        paypalRefundId,
        paymentDoc.amount,
        true
      );
      return {
        provider: "paypal",
        status: "succeeded",
        ...(paypalRefundId ? { providerRefundId: paypalRefundId } : {}),
      };
    } catch (err) {
      const errMsg = getPaymentErrorMessage(err);
      this.logger.error(
        `[CRITICAL] PayPal admin refund FAILED: bookingId=${bookingId}, captureId=${paymentDoc.paypalCaptureId}. MANUAL REFUND REQUIRED. Error: ${errMsg}`,
        { alert: "MONEY_RISK" }
      );
      await this.enqueueRefundFailureAlert(
        bookingId,
        paymentDoc.paypalCaptureId ?? "unknown",
        "paypal",
        errMsg
      );
      await this.markBookingPaid(bookingId);
      return { provider: "paypal", status: "failed", errorMessage: errMsg };
    }
  }

  /**
   * A full refund leaves the booking REFUNDED (the refund-module caller
   * then cancels it and its tickets). A partial refund must NOT mark the
   * booking as refunded — the customer keeps their confirmed booking and
   * valid tickets, so this reverts back to PAID (mirroring `markBookingPaid`
   * below, which does the same thing on outright provider failure).
   */
  private async markBookingRefunded(
    bookingId: string,
    isFullRefund: boolean
  ): Promise<void> {
    await this.bookingModel.updateOne(
      {
        _id: new Types.ObjectId(bookingId),
        paymentStatus: PaymentStatus.REFUND_PENDING,
      },
      {
        $set: {
          paymentStatus: isFullRefund
            ? PaymentStatus.REFUNDED
            : PaymentStatus.PAID,
        },
      }
    );
  }

  private async markBookingPaid(bookingId: string): Promise<void> {
    await this.bookingModel.updateOne(
      {
        _id: new Types.ObjectId(bookingId),
        paymentStatus: PaymentStatus.REFUND_PENDING,
      },
      { $set: { paymentStatus: PaymentStatus.PAID } }
    );
  }

  private async markPaymentRefunded(
    bookingId: string,
    provider: "stripe" | "paypal",
    providerRefundId: string | undefined,
    refundAmount: number | undefined,
    isFullRefund: boolean
  ): Promise<void> {
    // A booking can now have more than one Stripe refund over time (partial,
    // then later another partial or the exhausting one) — after the FIRST
    // refund, Payment.status is already "partially_refunded", not
    // "succeeded", so a filter matching only "succeeded" would silently
    // fail to update on every subsequent refund (rule.md 15.3: matchedCount
    // must be checked, not assumed).
    const result = await this.paymentModel.updateOne(
      {
        bookingId: new Types.ObjectId(bookingId),
        status: { $in: ["succeeded", "partially_refunded"] },
        isDeleted: false,
      },
      {
        $set: {
          status: isFullRefund ? "refunded" : "partially_refunded",
          refundedAt: new Date(),
          ...(provider === "stripe" && providerRefundId
            ? { stripeRefundId: providerRefundId }
            : {}),
          ...(provider === "paypal" && providerRefundId
            ? { paypalRefundId: providerRefundId }
            : {}),
        },
        // `refund.amount` from the provider is only THIS refund event's
        // amount, not a running total — accumulate it, mirroring
        // Booking.totalRefunded's own $inc.
        ...(refundAmount ? { $inc: { refundAmount } } : {}),
      }
    );

    if (result.matchedCount === 0) {
      // Money already moved at the provider by this point — this is a
      // bookkeeping drift, not a reason to report the refund as failed
      // (rule.md 3.5). Must not be silent though: this is exactly the
      // "Payment succeeded nhưng ticket/DB chưa đồng bộ" class of issue
      // docs/backend-roadmap/08 reconciliation reports are meant to catch.
      this.logger.error(
        `[RECONCILIATION_RISK] markPaymentRefunded matched no Payment document for bookingId=${bookingId}, provider=${provider}, providerRefundId=${providerRefundId ?? "unknown"} — Payment.status/refundAmount was NOT updated even though the provider refund succeeded. Manual reconciliation required.`
      );
    }
  }

  private extractPaypalRefundId(result: unknown): string | undefined {
    if (!result || typeof result !== "object") return undefined;
    const candidate = result as { id?: unknown };
    return typeof candidate.id === "string" ? candidate.id : undefined;
  }

  private async enqueueRefundFailureAlert(
    bookingId: string,
    paymentRef: string,
    source: "stripe" | "paypal",
    errorMessage: string
  ): Promise<void> {
    this.metricsService.refundFailuresTotal.inc({ source });
    try {
      await this.queueService.addJob({
        type: "refund-failure-alert",
        payload: {
          bookingId,
          paymentRef,
          source,
          errorMessage,
          occurredAt: new Date().toISOString(),
        },
      });
    } catch (alertErr) {
      this.logger.error(
        `[ALERT_ENQUEUE_FAILED] Could not enqueue refund failure alert for bookingId=${bookingId}: ${getPaymentErrorMessage(alertErr)}`
      );
    }
  }
}
