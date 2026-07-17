import { Injectable } from "@nestjs/common";
import type { PaymentWebhookEventDocument } from "../types/payment-ops-domain.types";
import type {
  PaymentWebhookEventDetail,
  PaymentWebhookEventListItem,
} from "../types/payment-ops.types";

@Injectable()
export class PaymentWebhookEventPresenter {
  toListItem(row: PaymentWebhookEventDocument): PaymentWebhookEventListItem {
    return {
      id: row._id.toString(),
      provider: row.provider,
      eventId: row.eventId,
      eventType: row.eventType,
      status: row.status,
      ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
      ...(row.processedAt
        ? { processedAt: row.processedAt.toISOString() }
        : {}),
      retryCount: row.retryCount,
      ...(row.lastRetriedAt
        ? { lastRetriedAt: row.lastRetriedAt.toISOString() }
        : {}),
      ...(row.createdAt ? { createdAt: row.createdAt.toISOString() } : {}),
      ...(row.updatedAt ? { updatedAt: row.updatedAt.toISOString() } : {}),
    };
  }

  toDetail(row: PaymentWebhookEventDocument): PaymentWebhookEventDetail {
    return {
      ...this.toListItem(row),
      payload: row.payload,
    };
  }
}
