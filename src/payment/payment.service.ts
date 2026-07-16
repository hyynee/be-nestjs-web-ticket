import { Injectable } from "@nestjs/common";
import Stripe from "stripe";
import { PaymentGatewayService } from "./infrastructure/gateway/payment-gateway.service";
import { PaymentIdempotencyService } from "./infrastructure/idempotency/payment-idempotency.service";
import { CreateCheckoutSessionUseCase } from "./application/use-case/create-checkout-session.use-case";
import { CreatePaypalTransactionUseCase } from "./application/use-case/create-paypal-transaction.use-case";
import { GetPaymentHistoryQuery } from "./application/use-case/get-payment-history.query";
import { CancelPaymentUseCase } from "./application/use-case/cancel-payment.use-case";
import { IssueAdminRefundUseCase } from "./application/use-case/issue-admin-refund.use-case";
import { HandleChargeRefundedUseCase } from "./application/use-case/handle-charge-refunded.use-case";
import { HandleStripeSideEventUseCase } from "./application/use-case/handle-stripe-side-event.use-case";
import { PaymentSettlementOrchestrator } from "./application/orchestrators/payment-settlement.orchestrator";
import type {
  CheckoutSessionResult,
  PaymentCancelResult,
  PaymentHistoryResult,
  PaypalCreateTransactionResult,
  PaypalFinalizeResult,
} from "./types/payment.types";
import type { QueryPaymentHistoryDto } from "./dto/query-payment-history.dto";

export type WebhookIdempotencyStatus = "new" | "processing" | "succeeded";

@Injectable()
export class PaymentService {
  constructor(
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentIdempotencyService: PaymentIdempotencyService,
    private readonly createCheckoutSessionUseCase: CreateCheckoutSessionUseCase,
    private readonly createPaypalTransactionUseCase: CreatePaypalTransactionUseCase,
    private readonly getPaymentHistoryQuery: GetPaymentHistoryQuery,
    private readonly cancelPaymentUseCase: CancelPaymentUseCase,
    private readonly issueAdminRefundUseCase: IssueAdminRefundUseCase,
    private readonly handleChargeRefundedUseCase: HandleChargeRefundedUseCase,
    private readonly handleStripeSideEventUseCase: HandleStripeSideEventUseCase,
    private readonly paymentSettlementOrchestrator: PaymentSettlementOrchestrator
  ) {}

  async acquireWebhookIdempotency(
    eventId: string
  ): Promise<WebhookIdempotencyStatus> {
    return this.paymentIdempotencyService.acquireWebhookIdempotency(eventId);
  }

  async checkWebhookIdempotencyFromDB(
    event: Stripe.Event
  ): Promise<WebhookIdempotencyStatus> {
    return this.paymentIdempotencyService.checkWebhookIdempotencyFromDB(event);
  }

  async markWebhookSucceeded(eventId: string): Promise<void> {
    await this.paymentIdempotencyService.markWebhookSucceeded(eventId);
  }

  async releaseWebhookProcessing(eventId: string): Promise<void> {
    await this.paymentIdempotencyService.releaseWebhookProcessing(eventId);
  }

  async createCheckoutSession(
    userId: string,
    bookingCode: string
  ): Promise<CheckoutSessionResult> {
    return this.createCheckoutSessionUseCase.execute(userId, bookingCode);
  }

  async createPaypalTransaction(
    userId: string,
    bookingCode: string
  ): Promise<PaypalCreateTransactionResult> {
    return this.createPaypalTransactionUseCase.execute(userId, bookingCode);
  }

  verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    return this.paymentGateway.verifyStripeWebhook(rawBody, signature);
  }

  async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    return this.handleStripeSideEventUseCase.handlePaymentIntentSucceeded(
      paymentIntent
    );
  }

  async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    return this.paymentSettlementOrchestrator.handleCheckoutSessionCompleted(
      session
    );
  }

  async finalizePaypalTransaction(
    orderId: string,
    userId: string
  ): Promise<PaypalFinalizeResult> {
    return this.paymentSettlementOrchestrator.finalizePaypalTransaction(
      orderId,
      userId
    );
  }

  async getPaymentHistory(
    userId: string,
    query: QueryPaymentHistoryDto = {}
  ): Promise<PaymentHistoryResult> {
    return this.getPaymentHistoryQuery.execute(userId, query);
  }

  async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    return this.handleChargeRefundedUseCase.execute(charge);
  }

  async handlePaymentCancelled(
    userId: string,
    bookingCode: string
  ): Promise<PaymentCancelResult | void> {
    return this.cancelPaymentUseCase.execute(userId, bookingCode);
  }

  async handlePaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    return this.handleStripeSideEventUseCase.handlePaymentIntentFailed(
      paymentIntent
    );
  }

  async handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    return this.handleStripeSideEventUseCase.handleChargeDisputeCreated(
      dispute
    );
  }

  async handlePaymentIntentCanceled(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    return this.handleStripeSideEventUseCase.handlePaymentIntentCanceled(
      paymentIntent
    );
  }

  async issueAdminRefund(
    bookingId: string,
    stripePaymentIntentId: string | undefined,
    adminId: string,
    reason: string
  ): Promise<void> {
    return this.issueAdminRefundUseCase.execute(
      bookingId,
      stripePaymentIntentId,
      adminId,
      reason
    );
  }

  async handleCheckoutSessionExpired(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    return this.handleStripeSideEventUseCase.handleCheckoutSessionExpired(
      session
    );
  }
}
