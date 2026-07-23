import { GetSystemSummaryUseCase } from "./get-system-summary.use-case";

describe("GetSystemSummaryUseCase", () => {
  it("aggregates counts from admin-ops repository, report repository, and queue stats", async () => {
    const adminOpsRepository = {
      countPendingBookings: jest.fn().mockResolvedValue(12),
      countPendingBookingsPastExpiry: jest.fn().mockResolvedValue(3),
      countTicketsMissingQr: jest.fn().mockResolvedValue(2),
      queryPaymentSucceededEmailFailed: jest
        .fn()
        .mockResolvedValue([{ notificationId: "n1" }]),
    };
    const reportRepository = {
      queryBookingPaidWithoutTicket: jest
        .fn()
        .mockResolvedValue([{ bookingId: "b1" }, { bookingId: "b2" }]),
    };
    const queueService = {
      getQueueStats: jest.fn().mockResolvedValue({
        default: { active: 1, waiting: 2, failed: 0, delayed: 0 },
        deadLetter: { waiting: 0, failed: 0 },
      }),
    };

    const useCase = new GetSystemSummaryUseCase(
      adminOpsRepository as never,
      reportRepository as never,
      queueService as never
    );

    const result = await useCase.execute();

    expect(result.pendingBookingsCount).toBe(12);
    expect(result.pendingBookingsPastExpiryCount).toBe(3);
    expect(result.ticketsMissingQrCount).toBe(2);
    expect(result.queue).toEqual({
      active: 1,
      waiting: 2,
      failed: 0,
      delayed: 0,
    });
    // 3 (pending past expiry) + 2 (missing QR) + 2 (paid w/o ticket) + 1 (email failed)
    expect(result.anomalyCount).toBe(8);
    expect(typeof result.generatedAt).toBe("string");
  });
});
