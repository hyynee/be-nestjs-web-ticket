import {
  RefundProvider,
  RefundRequestStatus,
} from "@src/schemas/refund-request.schema";

export interface RefundRequestDetail {
  id: string;
  bookingId: string;
  userId: string;
  eventId: string;
  amount: number;
  reason: string;
  status: RefundRequestStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  provider?: RefundProvider;
  providerRefundId?: string;
  failureReason?: string;
  metadata?: Record<string, string | number | boolean | Date | null>;
  createdAt?: string;
  updatedAt?: string;
}

export interface RefundRequestListResult {
  items: RefundRequestDetail[];
  total: number;
  page: number;
  limit: number;
}
