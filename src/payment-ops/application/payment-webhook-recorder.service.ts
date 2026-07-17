import { Injectable } from "@nestjs/common";
import { PaymentWebhookProvider } from "@src/schemas/payment-webhook-event.schema";
import { sanitizeSensitiveFields } from "@src/helper/sanitize.helper";
import Stripe from "stripe";
import { PaymentWebhookEventRepository } from "../infrastructure/persistence/payment-webhook-event.repository";
import { PaymentWebhookEventPresenter } from "../presenters/payment-webhook-event.presenter";
import type { PaymentWebhookEventDetail } from "../types/payment-ops.types";

@Injectable()
export class PaymentWebhookRecorderService {
  constructor(
    private readonly repository: PaymentWebhookEventRepository,
    private readonly presenter: PaymentWebhookEventPresenter
  ) {}

  async recordReceivedStripeEvent(
    event: Stripe.Event
  ): Promise<PaymentWebhookEventDetail> {
    const payload: Record<string, unknown> = {
      ...sanitizeSensitiveFields(event),
    };

    try {
      const row = await this.repository.upsertReceivedStripeEvent(
        event,
        payload
      );
      if (!row) {
        const existing = await this.repository.findByProviderEvent(
          PaymentWebhookProvider.STRIPE,
          event.id
        );
        if (!existing) {
          throw new Error("Stripe webhook event was not persisted");
        }
        return this.presenter.toDetail(existing);
      }
      return this.presenter.toDetail(row);
    } catch (error) {
      if (!this.isDuplicateKeyError(error)) throw error;

      const existing = await this.repository.findByProviderEvent(
        PaymentWebhookProvider.STRIPE,
        event.id
      );
      if (!existing) throw error;
      return this.presenter.toDetail(existing);
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
