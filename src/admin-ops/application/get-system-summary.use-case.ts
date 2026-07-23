import { Injectable } from "@nestjs/common";
import { QueueService } from "@src/queue/queue.service";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";
import { AdminOpsRepository } from "@src/admin-ops/infrastructure/persistence/admin-ops.repository";
import { AdminSystemSummaryResult } from "@src/admin-ops/domain/types/admin-ops.types";
import { allTimeReportRange } from "@src/admin-ops/domain/all-time-range.util";

@Injectable()
export class GetSystemSummaryUseCase {
  constructor(
    private readonly adminOpsRepository: AdminOpsRepository,
    private readonly reportRepository: ReportRepository,
    private readonly queueService: QueueService
  ) {}

  async execute(): Promise<AdminSystemSummaryResult> {
    const range = allTimeReportRange();

    const [
      pendingBookingsCount,
      pendingBookingsPastExpiryCount,
      ticketsMissingQrCount,
      bookingsPaidWithoutTicket,
      paymentSucceededEmailFailed,
      queueStats,
    ] = await Promise.all([
      this.adminOpsRepository.countPendingBookings(),
      this.adminOpsRepository.countPendingBookingsPastExpiry(),
      this.adminOpsRepository.countTicketsMissingQr(),
      this.reportRepository.queryBookingPaidWithoutTicket({}, range),
      this.adminOpsRepository.queryPaymentSucceededEmailFailed(),
      this.queueService.getQueueStats(),
    ]);

    return {
      generatedAt: new Date().toISOString(),
      pendingBookingsCount,
      pendingBookingsPastExpiryCount,
      ticketsMissingQrCount,
      queue: {
        active: queueStats.default.active ?? 0,
        waiting: queueStats.default.waiting ?? 0,
        failed: queueStats.default.failed ?? 0,
        delayed: queueStats.default.delayed ?? 0,
      },
      anomalyCount:
        pendingBookingsPastExpiryCount +
        ticketsMissingQrCount +
        bookingsPaidWithoutTicket.length +
        paymentSucceededEmailFailed.length,
    };
  }
}
