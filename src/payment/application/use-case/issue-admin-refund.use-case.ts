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
  ): Promise<void> {
    if (stripePaymentIntentId) {
      await this.issueStripeRefund(
        bookingId,
        stripePaymentIntentId,
        adminId,
        reason
      );
      return;
    }

    await this.issuePaypalRefund(bookingId, reason);
  }

  private async issueStripeRefund(
    bookingId: string,
    stripePaymentIntentId: string,
    adminId: string,
    reason: string
  ): Promise<void> {
    try {
      await this.paymentGateway.stripe.refunds.create(
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
    }
  }

  private async issuePaypalRefund(
    bookingId: string,
    reason: string
  ): Promise<void> {
    const paymentDoc = await this.paymentModel
      .findOne({
        bookingId: new Types.ObjectId(bookingId),
        paymentMethod: "paypal",
        status: "succeeded",
        isDeleted: false,
      })
      .select("paypalCaptureId")
      .lean<{ paypalCaptureId?: string }>();

    if (!paymentDoc?.paypalCaptureId) {
      this.logger.warn(
        `issueAdminRefund: no refundable payment found for bookingId=${bookingId}`
      );
      await this.markBookingPaid(bookingId);
      return;
    }

    try {
      const refundRequest = new paypalSdk.payments.CapturesRefundRequest(
        paymentDoc.paypalCaptureId
      );
      refundRequest.requestBody({
        note_to_payer: reason || "Admin cancellation",
      });
      await this.paymentGateway.withPaypalTimeout(
        this.paymentGateway.paypalClient.execute(refundRequest)
      );
      this.logger.log(
        `[REFUND] PayPal admin refund issued: bookingId=${bookingId}, captureId=${paymentDoc.paypalCaptureId}`
      );
      await this.markBookingRefunded(bookingId);
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
