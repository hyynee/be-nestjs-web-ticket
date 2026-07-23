import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaymentReconciliationQueryDto } from "@src/report/dto/report-query.dto";
import {
  ReportEventScope,
  ReportScopePolicy,
} from "@src/report/domain/policies/report-scope.policy";
import { toPaginatedResponse } from "@src/report/domain/report-pagination.util";
import {
  resolveReportDateRange,
  ResolvedReportRange,
} from "@src/report/domain/report-range.util";
import {
  PaymentReconciliationResult,
  ReconciliationCaseItem,
} from "@src/report/domain/types/report.types";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";

@Injectable()
export class PaymentReconciliationQueryService {
  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly scopePolicy: ReportScopePolicy,
    private readonly reportCache: ReportCacheService
  ) {}

  async execute(
    query: PaymentReconciliationQueryDto,
    currentUser: JwtPayload
  ): Promise<PaymentReconciliationResult> {
    const scope = await this.scopePolicy.resolveEventScope(
      currentUser,
      query.eventId
    );
    const range = resolveReportDateRange(query.from, query.to);

    return this.reportCache.reconciliationReport(
      scope,
      range,
      query.page,
      query.limit,
      () => this.computeResult(scope, range, query)
    );
  }

  private async computeResult(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    query: PaymentReconciliationQueryDto
  ): Promise<PaymentReconciliationResult> {
    const isUnrestrictedAdminScope = !scope.eventIdEq && !scope.eventIdIn;

    const [
      paymentNotConfirmed,
      bookingNoTicket,
      bookingNotRefunded,
      webhookFailed,
      duplicatePayments,
    ] = await Promise.all([
      this.reportRepository.queryPaymentSucceededBookingNotConfirmed(
        scope,
        range
      ),
      this.reportRepository.queryBookingPaidWithoutTicket(scope, range),
      this.reportRepository.queryBookingCancelledNotRefunded(scope, range),
      // PaymentWebhookEvent cannot be attributed to a specific event — only
      // surface it for an unrestricted (global admin) view.
      isUnrestrictedAdminScope
        ? this.reportRepository.queryPaymentWebhookFailed(range)
        : Promise.resolve([]),
      this.reportRepository.queryDuplicatePaymentRecords(scope, range),
    ]);

    const cases: ReconciliationCaseItem[] = [
      ...paymentNotConfirmed.map((row): ReconciliationCaseItem => ({
        type: "payment_succeeded_booking_not_confirmed",
        bookingId: row.bookingId,
        bookingCode: row.bookingCode,
        paymentId: row.paymentId,
        eventId: row.eventId,
        amount: row.amount,
        detectedAt: row.detectedAt.toISOString(),
        details: `Payment ${row.paymentId} succeeded but booking ${row.bookingCode} is not confirmed`,
      })),
      ...bookingNoTicket.map((row): ReconciliationCaseItem => ({
        type: "booking_paid_without_ticket",
        bookingId: row.bookingId,
        bookingCode: row.bookingCode,
        eventId: row.eventId,
        amount: row.amount,
        detectedAt: row.detectedAt.toISOString(),
        details: `Booking ${row.bookingCode} is paid but has no issued ticket`,
      })),
      ...bookingNotRefunded.map((row): ReconciliationCaseItem => ({
        type: "booking_cancelled_not_refunded",
        bookingId: row.bookingId,
        bookingCode: row.bookingCode,
        eventId: row.eventId,
        amount: row.amount,
        detectedAt: row.detectedAt.toISOString(),
        details: `Booking ${row.bookingCode} is cancelled but ${row.amount} is not yet refunded`,
      })),
      ...webhookFailed.map((row): ReconciliationCaseItem => ({
        type: "payment_webhook_failed",
        detectedAt: row.detectedAt.toISOString(),
        details: `${row.provider} webhook "${row.eventType}" failed: ${row.errorMessage ?? "unknown error"}`,
      })),
      ...duplicatePayments.map((row): ReconciliationCaseItem => ({
        type: "duplicate_payment_record",
        bookingId: row.bookingId,
        eventId: row.eventId,
        amount: row.amount,
        detectedAt: row.detectedAt.toISOString(),
        details: `Booking ${row.bookingId} has ${row.count} succeeded payment records: ${row.paymentIds.join(", ")}`,
      })),
    ].sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));

    const start = (query.page - 1) * query.limit;
    const pageItems = cases.slice(start, start + query.limit);

    return {
      range: { from: range.fromIso, to: range.toIso },
      summary: {
        paymentSucceededBookingNotConfirmed: paymentNotConfirmed.length,
        bookingPaidWithoutTicket: bookingNoTicket.length,
        bookingCancelledNotRefunded: bookingNotRefunded.length,
        paymentWebhookFailed: webhookFailed.length,
        duplicatePaymentRecords: duplicatePayments.length,
      },
      cases: toPaginatedResponse(
        pageItems,
        query.page,
        query.limit,
        cases.length
      ),
    };
  }
}
