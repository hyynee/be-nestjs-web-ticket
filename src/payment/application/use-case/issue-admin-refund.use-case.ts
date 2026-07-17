import { Injectable, Logger } from "@nestjs/common";
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
import type { AdminRefundResult } from "@src/payment/types/payment.types";

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
    reason: string
  ): Promise<AdminRefundResult> {
    if (stripePaymentIntentId) {
      return this.issueStripeRefund(
        bookingId,
        stripePaymentIntentId,
        adminId,
        reason
      );
    }

    return this.issuePaypalRefund(bookingId, reason);
  }

  private async issueStripeRefund(
    bookingId: string,
    stripePaymentIntentId: string,
    adminId: string,
    reason: string
  ): Promise<AdminRefundResult> {
    try {
      const refund = await this.paymentGateway.stripe.refunds.create(
        {
          payment_intent: stripePaymentIntentId,
          metadata: { reason, bookingId, adminId, source: "admin_cancel" },
        },
        { idempotencyKey: `admin-refund:${bookingId}` }
      );
      this.logger.log(
        `[REFUND] Stripe admin refund issued: bookingId=${bookingId}, pi=${stripePaymentIntentId}`
      );
      await this.markBookingRefunded(bookingId);
      await this.markPaymentRefunded(
        bookingId,
        "stripe",
        refund.id,
        refund.amount
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
    reason: string
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
      const refundResult = await this.paymentGateway.withPaypalTimeout(
        this.paymentGateway.paypalClient.execute(refundRequest)
      );
      const paypalRefundId = this.extractPaypalRefundId(refundResult.result);
      this.logger.log(
        `[REFUND] PayPal admin refund issued: bookingId=${bookingId}, captureId=${paymentDoc.paypalCaptureId}`
      );
      await this.markBookingRefunded(bookingId);
      await this.markPaymentRefunded(
        bookingId,
        "paypal",
        paypalRefundId,
        paymentDoc.amount
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

  private async markBookingRefunded(bookingId: string): Promise<void> {
    await this.bookingModel.updateOne(
      {
        _id: new Types.ObjectId(bookingId),
        paymentStatus: PaymentStatus.REFUND_PENDING,
      },
      { $set: { paymentStatus: PaymentStatus.REFUNDED } }
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
    refundAmount: number | undefined
  ): Promise<void> {
    await this.paymentModel.updateOne(
      {
        bookingId: new Types.ObjectId(bookingId),
        status: "succeeded",
        isDeleted: false,
      },
      {
        $set: {
          status: "refunded",
          refundedAt: new Date(),
          ...(refundAmount ? { refundAmount } : {}),
          ...(provider === "stripe" && providerRefundId
            ? { stripeRefundId: providerRefundId }
            : {}),
          ...(provider === "paypal" && providerRefundId
            ? { paypalRefundId: providerRefundId }
            : {}),
        },
      }
    );
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
