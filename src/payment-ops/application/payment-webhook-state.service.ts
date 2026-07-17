import { Injectable } from "@nestjs/common";
import {
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";
import { PaymentWebhookEventRepository } from "../infrastructure/persistence/payment-webhook-event.repository";

@Injectable()
export class PaymentWebhookStateService {
  constructor(private readonly repository: PaymentWebhookEventRepository) {}

  async markProcessing(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<void> {
    await this.repository.updateStatus(provider, eventId, {
      $set: { status: PaymentWebhookEventStatus.PROCESSING },
      $unset: { errorMessage: "" },
    });
  }

  async markSucceeded(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<void> {
    await this.repository.updateStatus(provider, eventId, {
      $set: {
        status: PaymentWebhookEventStatus.SUCCEEDED,
        processedAt: new Date(),
      },
      $unset: { errorMessage: "" },
    });
  }

  async markIgnored(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<void> {
    await this.repository.updateStatus(provider, eventId, {
      $set: {
        status: PaymentWebhookEventStatus.IGNORED,
        processedAt: new Date(),
      },
      $unset: { errorMessage: "" },
    });
  }

  async markFailed(
    provider: PaymentWebhookProvider,
    eventId: string,
    error: unknown
  ): Promise<void> {
    await this.repository.updateStatus(provider, eventId, {
      $set: {
        status: PaymentWebhookEventStatus.FAILED,
        errorMessage: this.getErrorMessage(error),
      },
    });
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
