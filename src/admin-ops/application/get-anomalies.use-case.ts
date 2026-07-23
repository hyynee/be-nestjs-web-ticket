import { Injectable } from "@nestjs/common";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";
import { toPaginatedResponse } from "@src/report/domain/report-pagination.util";
import { AdminAnomalyQueryDto } from "@src/admin-ops/dto/admin-anomaly-query.dto";
import { AdminOpsRepository } from "@src/admin-ops/infrastructure/persistence/admin-ops.repository";
import {
  AdminAnomalyItem,
  AdminAnomalyResult,
} from "@src/admin-ops/domain/types/admin-ops.types";
import { allTimeReportRange } from "@src/admin-ops/domain/all-time-range.util";

@Injectable()
export class GetAnomaliesUseCase {
  constructor(
    private readonly adminOpsRepository: AdminOpsRepository,
    private readonly reportRepository: ReportRepository
  ) {}

  async execute(query: AdminAnomalyQueryDto): Promise<AdminAnomalyResult> {
    const range = allTimeReportRange();

    const [
      bookingsPaidWithoutTicket,
      ticketsMissingQr,
      paymentEmailFailed,
      bookingsPendingPastExpiry,
    ] = await Promise.all([
      this.reportRepository.queryBookingPaidWithoutTicket({}, range),
      this.adminOpsRepository.queryTicketsMissingQr(),
      this.adminOpsRepository.queryPaymentSucceededEmailFailed(),
      this.adminOpsRepository.queryBookingsPendingPastExpiry(),
    ]);

    const items: AdminAnomalyItem[] = [
      ...bookingsPaidWithoutTicket.map((row): AdminAnomalyItem => ({
        type: "booking_paid_without_ticket",
        bookingId: row.bookingId,
        bookingCode: row.bookingCode,
        eventId: row.eventId,
        detectedAt: row.detectedAt.toISOString(),
        details: `Booking ${row.bookingCode} is paid but has no issued ticket`,
      })),
      ...ticketsMissingQr.map((row): AdminAnomalyItem => ({
        type: "ticket_missing_qr",
        ticketId: row.ticketId,
        ticketCode: row.ticketCode,
        bookingId: row.bookingId,
        eventId: row.eventId,
        detectedAt: row.detectedAt.toISOString(),
        details: `Ticket ${row.ticketCode} has no QR code`,
      })),
      ...paymentEmailFailed.map((row): AdminAnomalyItem => ({
        type: "payment_succeeded_email_failed",
        bookingCode: row.bookingCode,
        detectedAt: row.detectedAt.toISOString(),
        details: `Booking confirmation email${row.bookingCode ? ` for booking ${row.bookingCode}` : ""} failed: ${row.errorMessage ?? "unknown error"}`,
      })),
      ...bookingsPendingPastExpiry.map((row): AdminAnomalyItem => ({
        type: "booking_pending_past_expiry",
        bookingId: row.bookingId,
        bookingCode: row.bookingCode,
        eventId: row.eventId,
        detectedAt: row.detectedAt.toISOString(),
        details: `Booking ${row.bookingCode} is still pending ${this.minutesPastExpiry(row.expiresAt)} minutes past its expiry`,
      })),
    ].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

    const start = (query.page - 1) * query.limit;
    const pageItems = items.slice(start, start + query.limit);

    return {
      summary: {
        bookingPaidWithoutTicket: bookingsPaidWithoutTicket.length,
        ticketMissingQr: ticketsMissingQr.length,
        paymentSucceededEmailFailed: paymentEmailFailed.length,
        bookingPendingPastExpiry: bookingsPendingPastExpiry.length,
      },
      items: toPaginatedResponse(
        pageItems,
        query.page,
        query.limit,
        items.length
      ),
    };
  }

  private minutesPastExpiry(expiresAt: Date): number {
    return Math.max(0, Math.round((Date.now() - expiresAt.getTime()) / 60_000));
  }
}
