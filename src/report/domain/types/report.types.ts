import { PaginatedResponse } from "@src/common/interfaces/pagination-response";

export type ReportGroupBy = "day" | "week" | "month";

export interface ReportDateRange {
  from: string;
  to: string;
}

/**
 * Sales report is computed from Booking (not Payment) so gross/net/refund
 * figures always reconcile: totalPrice/totalRefunded are the fields the
 * refund workflow already keeps authoritative on Booking, and Payment can
 * have multiple failed/duplicate rows per booking which would double count.
 */
export interface SalesReportSummary {
  grossRevenue: number;
  netRevenue: number;
  refundAmount: number;
  ticketsSold: number;
  bookingCount: number;
  averageOrderValue: number;
  currency: string;
}

export interface SalesReportTimeSeriesPoint {
  label: string;
  grossRevenue: number;
  netRevenue: number;
  refundAmount: number;
  bookingCount: number;
}

export interface SalesReportEventBreakdownRow {
  eventId: string;
  eventName: string;
  grossRevenue: number;
  netRevenue: number;
  refundAmount: number;
  ticketsSold: number;
}

export interface SalesReportZoneBreakdownRow {
  zoneId: string;
  zoneName: string;
  eventId: string;
  grossRevenue: number;
  netRevenue: number;
  ticketsSold: number;
}

export interface SalesReportResult {
  range: ReportDateRange;
  groupBy: ReportGroupBy;
  summary: SalesReportSummary;
  timeSeries: SalesReportTimeSeriesPoint[];
  revenueByEvent: PaginatedResponse<SalesReportEventBreakdownRow>;
  revenueByZone: PaginatedResponse<SalesReportZoneBreakdownRow>;
}

export interface CheckInReportSummary {
  totalValidTickets: number;
  checkedInTickets: number;
  noShowCount: number;
  checkInRate: number;
}

export interface CheckInByHourRow {
  hour: string;
  count: number;
}

export interface CheckInByZoneRow {
  zoneId: string;
  zoneName: string;
  totalTickets: number;
  checkedInCount: number;
  checkInRate: number;
}

export interface CheckInByStaffRow {
  staffId: string;
  staffName: string;
  checkedInCount: number;
}

export interface CheckInReportResult {
  range: ReportDateRange;
  summary: CheckInReportSummary;
  checkInByHour: CheckInByHourRow[];
  checkInByZone: PaginatedResponse<CheckInByZoneRow>;
  checkInByStaff: PaginatedResponse<CheckInByStaffRow>;
}

export interface RefundReportSummary {
  requested: number;
  approved: number;
  rejected: number;
  succeeded: number;
  failed: number;
  totalRefundAmount: number;
}

export interface RefundAmountByEventRow {
  eventId: string;
  eventName: string;
  refundAmount: number;
  refundCount: number;
}

export interface RefundAmountByProviderRow {
  provider: string;
  refundAmount: number;
  refundCount: number;
}

export interface RefundReportResult {
  range: ReportDateRange;
  summary: RefundReportSummary;
  refundAmountByEvent: PaginatedResponse<RefundAmountByEventRow>;
  refundAmountByProvider: RefundAmountByProviderRow[];
}

export type ReconciliationCaseType =
  | "payment_succeeded_booking_not_confirmed"
  | "booking_paid_without_ticket"
  | "booking_cancelled_not_refunded"
  | "payment_webhook_failed"
  | "duplicate_payment_record";

export interface ReconciliationCaseItem {
  type: ReconciliationCaseType;
  bookingId?: string;
  bookingCode?: string;
  paymentId?: string;
  eventId?: string;
  amount?: number;
  detectedAt: string;
  details: string;
}

export interface PaymentReconciliationSummary {
  paymentSucceededBookingNotConfirmed: number;
  bookingPaidWithoutTicket: number;
  bookingCancelledNotRefunded: number;
  paymentWebhookFailed: number;
  duplicatePaymentRecords: number;
}

export interface PaymentReconciliationResult {
  range: ReportDateRange;
  summary: PaymentReconciliationSummary;
  cases: PaginatedResponse<ReconciliationCaseItem>;
}

export interface OrganizerEventBreakdownRow {
  eventId: string;
  eventName: string;
  grossRevenue: number;
  netRevenue: number;
  ticketsSold: number;
  checkedInCount: number;
}

export interface OrganizerReportResult {
  organizerId: string;
  range: ReportDateRange;
  totalEventsManaged: number;
  sales: SalesReportSummary;
  checkIn: CheckInReportSummary;
  refunds: RefundReportSummary;
  events: PaginatedResponse<OrganizerEventBreakdownRow>;
}
