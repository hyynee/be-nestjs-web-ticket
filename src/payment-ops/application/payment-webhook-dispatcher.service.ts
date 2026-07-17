import { BadRequestException, Injectable } from "@nestjs/common";
import { Inject, forwardRef } from "@nestjs/common";
import { PaymentService } from "@src/payment/payment.service";
import { PaymentWebhookProvider } from "@src/schemas/payment-webhook-event.schema";
import Stripe from "stripe";
import type { PaymentWebhookEventDocument } from "../types/payment-ops-domain.types";

type StripeEventPayload = {
  data?: {
    object?: unknown;
  };
};

@Injectable()
export class PaymentWebhookDispatcherService {
  constructor(
    @Inject(forwardRef(() => PaymentService))
    private readonly paymentService: PaymentService
  ) {}

  async dispatchStripeEvent(
    row: PaymentWebhookEventDocument
  ): Promise<boolean> {
    if (row.provider !== PaymentWebhookProvider.STRIPE) {
      throw new BadRequestException("Only Stripe webhook retry is supported");
    }

    const event = this.getStripePayload(row);
    switch (row.eventType) {
      case "payment_intent.succeeded":
        await this.paymentService.handlePaymentIntentSucceeded(
          event.data.object as Stripe.PaymentIntent
        );
        return true;
      case "checkout.session.completed":
        await this.paymentService.handleCheckoutSessionCompleted(
          event.data.object as Stripe.Checkout.Session
        );
        return true;
      case "charge.refunded":
        await this.paymentService.handleChargeRefunded(
          event.data.object as Stripe.Charge
        );
        return true;
      case "payment_intent.payment_failed":
        await this.paymentService.handlePaymentIntentFailed(
          event.data.object as Stripe.PaymentIntent
        );
        return true;
      case "charge.dispute.created":
        await this.paymentService.handleChargeDisputeCreated(
          event.data.object as Stripe.Dispute
        );
        return true;
      case "payment_intent.canceled":
        await this.paymentService.handlePaymentIntentCanceled(
          event.data.object as Stripe.PaymentIntent
        );
        return true;
      case "checkout.session.expired":
        await this.paymentService.handleCheckoutSessionExpired(
          event.data.object as Stripe.Checkout.Session
        );
        return true;
      default:
        return false;
    }
  }

  private getStripePayload(row: PaymentWebhookEventDocument): {
    data: { object: unknown };
  } {
    const payload: StripeEventPayload = row.payload;
    if (!payload.data || !("object" in payload.data)) {
      throw new BadRequestException("Webhook payload is missing data.object");
    }
    return { data: { object: payload.data.object } };
  }
}
