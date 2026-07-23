import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { TicketIssuedItem } from "@src/ticket/types/ticket.types";

export type AdminAnomalyType =
  | "booking_paid_without_ticket"
  | "ticket_missing_qr"
  | "payment_succeeded_email_failed"
  | "booking_pending_past_expiry";

export interface AdminAnomalyItem {
  type: AdminAnomalyType;
  bookingId?: string;
  bookingCode?: string;
  ticketId?: string;
  ticketCode?: string;
  eventId?: string;
  detectedAt: string;
  details: string;
}

export interface AdminAnomalySummary {
  bookingPaidWithoutTicket: number;
  ticketMissingQr: number;
  paymentSucceededEmailFailed: number;
  bookingPendingPastExpiry: number;
}

export interface AdminAnomalyResult {
  summary: AdminAnomalySummary;
  items: PaginatedResponse<AdminAnomalyItem>;
}

export interface AdminSystemQueueSummary {
  active: number;
  waiting: number;
  failed: number;
  delayed: number;
}

export interface AdminSystemSummaryResult {
  generatedAt: string;
  pendingBookingsCount: number;
  pendingBookingsPastExpiryCount: number;
  ticketsMissingQrCount: number;
  queue: AdminSystemQueueSummary;
  anomalyCount: number;
}

export interface ReissueTicketsResult {
  bookingCode: string;
  tickets: TicketIssuedItem[];
}

export interface ResendConfirmationResult {
  bookingCode: string;
  status: "queued";
}

export type RegenerateQrResult = TicketIssuedItem;
