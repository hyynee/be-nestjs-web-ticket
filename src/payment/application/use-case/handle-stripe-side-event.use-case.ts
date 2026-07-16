import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { MetricsService } from "@src/metrics/metrics.service";
import { QueueService } from "@src/queue/queue.service";
import { RedisService } from "@src/redis/redis.service";
import { Model } from "mongoose";
import Stripe from "stripe";

@Injectable()
export class HandleStripeSideEventUseCase {
  private readonly logger = new Logger(HandleStripeSideEventUseCase.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    private readonly queueService: QueueService,
    private readonly metricsService: MetricsService,
    private readonly redisService: RedisService
  ) {}

  async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    this.logger.debug(`payment_intent.succeeded received: ${paymentIntent.id}`);
  }

  async handlePaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    this.logger.warn(
      `payment_intent.payment_failed: id=${paymentIntent.id} reason=${paymentIntent.last_payment_error?.message ?? "unknown"}`
    );
    await this.paymentModel
      .updateOne(
        { stripePaymentIntentId: paymentIntent.id, isDeleted: false },
        {
          $set: {
            status: "failed",
            failureReason: paymentIntent.last_payment_error?.message,
          },
        }
      )
      .catch((err: unknown) =>
        this.logger.error(
          `handlePaymentIntentFailed: DB update failed: ${getPaymentErrorMessage(err)}`
        )
      );
  }

  async handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    const paymentIntentId =
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent?.id;

    this.logger.error(
      `charge.dispute.created: disputeId=${dispute.id} paymentIntentId=${paymentIntentId} reason=${dispute.reason} amount=${dispute.amount}`
    );

    if (!paymentIntentId) return;

    const booking = await this.bookingModel
      .findOne({ stripePaymentIntentId: paymentIntentId, isDeleted: false })
      .select("_id bookingCode");

    if (!booking) {
      this.logger.warn(
        `handleChargeDisputeCreated: no booking found for paymentIntentId=${paymentIntentId}`
      );
      return;
    }

    await this.bookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          disputeId: dispute.id,
          disputeReason: dispute.reason,
          disputeStatus: "open",
        },
      }
    );

    const dueBySec = dispute.evidence_details?.due_by;
    const dueByIso = dueBySec
      ? new Date(dueBySec * 1000).toISOString()
      : "unknown (check Stripe dashboard)";

    this.logger.error(
      `FRAUD ALERT: Booking ${booking.bookingCode} has an open dispute (${dispute.reason}). Evidence due: ${dueByIso}`
    );

    await this.enqueueRefundFailureAlert(
      booking._id.toString(),
      paymentIntentId,
      "stripe",
      `Dispute opened — reason: ${dispute.reason}, evidence due: ${dueByIso}, amount: ${dispute.amount}`
    );
  }

  async handlePaymentIntentCanceled(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    this.logger.warn(`payment_intent.canceled: id=${paymentIntent.id}`);

    const booking = await this.bookingModel
      .findOne({ stripePaymentIntentId: paymentIntent.id, isDeleted: false })
      .select("_id bookingCode status paymentStatus");

    if (!booking) return;

    if (booking.status === BookingStatus.CONFIRMED) {
      this.logger.error(
        `ALERT: PaymentIntent ${paymentIntent.id} canceled but booking ${booking.bookingCode} is CONFIRMED. Manual review required.`
      );
    }
  }

  async handleCheckoutSessionExpired(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    this.logger.debug(`checkout.session.expired: id=${session.id}`);
    const { bookingId } = session.metadata || {};
    if (!bookingId) return;

    const dedupKey = `checkout:session:${bookingId}`;
    await this.redisService.client.del(dedupKey).catch((error: unknown) => {
      this.logger.warn(
        `checkout session dedup cleanup failed for session ${session.id}: ${getPaymentErrorMessage(error)}`
      );
    });
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
