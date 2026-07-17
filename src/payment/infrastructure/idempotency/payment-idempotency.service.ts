import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { RedisService } from "@src/redis/redis.service";
import { Model } from "mongoose";
import Stripe from "stripe";
import {
  PAYMENT_PROCESSING_TTL_SEC,
  PAYMENT_SUCCEEDED_TTL_SEC,
  WEBHOOK_RELEASE_SCRIPT,
} from "@src/payment/payment.constants";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import type { WebhookIdempotencyStatus } from "@src/payment/payment.service";

@Injectable()
export class PaymentIdempotencyService {
  private readonly logger = new Logger(PaymentIdempotencyService.name);

  constructor(
    private readonly redisService: RedisService,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>
  ) {}

  async acquireWebhookIdempotency(
    eventId: string
  ): Promise<WebhookIdempotencyStatus> {
    if (!eventId) {
      throw new BadRequestException("Missing Stripe event id");
    }

    const key = this.getPaymentIdempotencyKey(eventId);

    try {
      const acquired = await this.redisService.client.set(key, "processing", {
        NX: true,
        EX: PAYMENT_PROCESSING_TTL_SEC,
      });

      if (acquired === "OK") return "new";

      const currentValue = await this.redisService.client.get(key);
      return currentValue === "succeeded" ? "succeeded" : "processing";
    } catch (error) {
      this.logger.warn(
        `Redis unavailable for webhook idempotency ${eventId}: ${getPaymentErrorMessage(error)} — falling back to DB`
      );
      throw new ServiceUnavailableException("__redis_down__");
    }
  }

  async checkWebhookIdempotencyFromDB(
    event: Stripe.Event
  ): Promise<WebhookIdempotencyStatus> {
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentIntentId = session.payment_intent as string | undefined;
        if (paymentIntentId) {
          const booking = await this.bookingModel
            .findOne({
              stripePaymentIntentId: paymentIntentId,
              status: BookingStatus.CONFIRMED,
              paymentStatus: PaymentStatus.PAID,
              isDeleted: false,
            })
            .select("_id")
            .lean();
          if (booking) return "succeeded";
        }
      }

      if (event.type === "charge.refunded") {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = charge.payment_intent as string | undefined;
        if (paymentIntentId) {
          const payment = await this.paymentModel
            .findOne({
              stripePaymentIntentId: paymentIntentId,
              status: "refunded",
              isDeleted: false,
            })
            .select("_id")
            .lean();
          if (payment) return "succeeded";
        }
      }
    } catch (dbErr) {
      this.logger.error(
        `checkWebhookIdempotencyFromDB failed for event ${event.id}: ${getPaymentErrorMessage(dbErr)}`
      );
      throw dbErr;
    }

    this.logger.warn(
      `Processing webhook ${event.id} (${event.type}) without Redis dedup — MongoDB write guards are active`
    );
    return "new";
  }

  async markWebhookSucceeded(eventId: string): Promise<void> {
    const key = this.getPaymentIdempotencyKey(eventId);
    try {
      await this.redisService.client.set(key, "succeeded", {
        EX: PAYMENT_SUCCEEDED_TTL_SEC,
      });
    } catch (error) {
      this.logger.warn(
        `Redis unavailable when marking webhook ${eventId} succeeded — event was processed, returning 200 regardless: ${getPaymentErrorMessage(error)}`
      );
    }
  }

  async releaseWebhookProcessing(eventId: string): Promise<void> {
    const key = this.getPaymentIdempotencyKey(eventId);
    try {
      await this.redisService.client.eval(WEBHOOK_RELEASE_SCRIPT, {
        keys: [key],
        arguments: ["processing"],
      });
    } catch (error) {
      this.logger.warn(
        `Redis unavailable when releasing webhook ${eventId} processing lock — processing TTL is the safety net: ${getPaymentErrorMessage(error)}`
      );
    }
  }

  async acquirePaypalLock(orderId: string): Promise<WebhookIdempotencyStatus> {
    const key = this.getPaypalLockKey(orderId);
    try {
      const acquired = await this.redisService.client.set(key, "processing", {
        NX: true,
        EX: PAYMENT_PROCESSING_TTL_SEC,
      });
      if (acquired === "OK") return "new";
      const current = await this.redisService.client.get(key);
      return current === "succeeded" ? "succeeded" : "processing";
    } catch (error) {
      this.logger.error(
        `PayPal lock unavailable for order ${orderId}: ${getPaymentErrorMessage(error)}`
      );
      throw new ServiceUnavailableException(
        "Payment lock temporarily unavailable"
      );
    }
  }

  async markPaypalSucceeded(orderId: string): Promise<void> {
    const key = this.getPaypalLockKey(orderId);
    await this.redisService.client.set(key, "succeeded", {
      EX: PAYMENT_SUCCEEDED_TTL_SEC,
    });
  }

  async releasePaypalLock(orderId: string): Promise<void> {
    const key = this.getPaypalLockKey(orderId);
    await this.redisService.client.eval(WEBHOOK_RELEASE_SCRIPT, {
      keys: [key],
      arguments: ["processing"],
    });
  }

  private getPaymentIdempotencyKey(eventId: string): string {
    return `idemp:payment:${eventId}`;
  }

  private getPaypalLockKey(orderId: string): string {
    return `paypal:lock:${orderId}`;
  }
}
