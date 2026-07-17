import {
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";

export interface PaymentWebhookEventListItem {
  id: string;
  provider: PaymentWebhookProvider;
  eventId: string;
  eventType: string;
  status: PaymentWebhookEventStatus;
  errorMessage?: string;
  processedAt?: string;
  retryCount: number;
  lastRetriedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PaymentWebhookEventDetail extends PaymentWebhookEventListItem {
  payload: Record<string, unknown>;
}

export interface PaymentWebhookEventListResult {
  items: PaymentWebhookEventListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface PaymentWebhookRetryResult {
  event: PaymentWebhookEventDetail;
}
