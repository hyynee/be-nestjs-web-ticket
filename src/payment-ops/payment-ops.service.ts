import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaymentWebhookProvider } from "@src/schemas/payment-webhook-event.schema";
import Stripe from "stripe";
import { PaymentWebhookQueryService } from "./application/payment-webhook-query.service";
import { PaymentWebhookRecorderService } from "./application/payment-webhook-recorder.service";
import { PaymentWebhookStateService } from "./application/payment-webhook-state.service";
import { RetryWebhookEventUseCase } from "./application/retry-webhook-event.use-case";
import { QueryWebhookEventDto } from "./dto/query-webhook-event.dto";
import type {
  PaymentWebhookEventDetail,
  PaymentWebhookEventListResult,
  PaymentWebhookRetryResult,
} from "./types/payment-ops.types";

@Injectable()
export class PaymentOpsService {
  constructor(
    private readonly recorder: PaymentWebhookRecorderService,
    private readonly state: PaymentWebhookStateService,
    private readonly queries: PaymentWebhookQueryService,
    private readonly retryWebhook: RetryWebhookEventUseCase
  ) {}

  recordReceivedStripeEvent(
    event: Stripe.Event
  ): Promise<PaymentWebhookEventDetail> {
    return this.recorder.recordReceivedStripeEvent(event);
  }

  markProcessing(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<void> {
    return this.state.markProcessing(provider, eventId);
  }

  markSucceeded(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<void> {
    return this.state.markSucceeded(provider, eventId);
  }

  markIgnored(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<void> {
    return this.state.markIgnored(provider, eventId);
  }

  markFailed(
    provider: PaymentWebhookProvider,
    eventId: string,
    error: unknown
  ): Promise<void> {
    return this.state.markFailed(provider, eventId, error);
  }

  findAll(query: QueryWebhookEventDto): Promise<PaymentWebhookEventListResult> {
    return this.queries.findAll(query);
  }

  findById(id: string): Promise<PaymentWebhookEventDetail> {
    return this.queries.findById(id);
  }

  retryWebhookEvent(
    id: string,
    admin: JwtPayload
  ): Promise<PaymentWebhookRetryResult> {
    return this.retryWebhook.execute(id, admin);
  }
}
