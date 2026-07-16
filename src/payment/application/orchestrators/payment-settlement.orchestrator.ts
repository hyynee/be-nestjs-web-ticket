import { Injectable } from "@nestjs/common";
import { PaypalPaymentSettlementService } from "@src/payment/application/services/paypal-payment-settlement.service";
import { StripePaymentSettlementService } from "@src/payment/application/services/stripe-payment-settlement.service";
import type { PaypalFinalizeResult } from "@src/payment/types/payment.types";
import Stripe from "stripe";

@Injectable()
export class PaymentSettlementOrchestrator {
  constructor(
    private readonly stripeSettlement: StripePaymentSettlementService,
    private readonly paypalSettlement: PaypalPaymentSettlementService
  ) {}

  async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    return this.stripeSettlement.handleCheckoutSessionCompleted(session);
  }

  async finalizePaypalTransaction(
    orderId: string,
    userId: string
  ): Promise<PaypalFinalizeResult> {
    return this.paypalSettlement.finalizePaypalTransaction(orderId, userId);
  }
}
