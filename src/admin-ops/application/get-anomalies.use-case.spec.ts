import { GetAnomaliesUseCase } from "./get-anomalies.use-case";

describe("GetAnomaliesUseCase", () => {
  function makeUseCase(overrides: {
    bookingPaidWithoutTicket?: unknown[];
    ticketsMissingQr?: unknown[];
    paymentEmailFailed?: unknown[];
    bookingsPendingPastExpiry?: unknown[];
  }) {
    const reportRepository = {
      queryBookingPaidWithoutTicket: jest
        .fn()
        .mockResolvedValue(overrides.bookingPaidWithoutTicket ?? []),
    };
    const adminOpsRepository = {
      queryTicketsMissingQr: jest
        .fn()
        .mockResolvedValue(overrides.ticketsMissingQr ?? []),
      queryPaymentSucceededEmailFailed: jest
        .fn()
        .mockResolvedValue(overrides.paymentEmailFailed ?? []),
      queryBookingsPendingPastExpiry: jest
        .fn()
        .mockResolvedValue(overrides.bookingsPendingPastExpiry ?? []),
    };
    return new GetAnomaliesUseCase(
      adminOpsRepository as never,
      reportRepository as never
    );
  }

  it("returns zeroed summary and empty page when nothing is detected", async () => {
    const useCase = makeUseCase({});

    const result = await useCase.execute({ page: 1, limit: 20 });

    expect(result.summary).toEqual({
      bookingPaidWithoutTicket: 0,
      ticketMissingQr: 0,
      paymentSucceededEmailFailed: 0,
      bookingPendingPastExpiry: 0,
    });
    expect(result.items.items).toHaveLength(0);
    expect(result.items.meta.totalItems).toBe(0);
  });

  it("merges all 4 anomaly types, sorts by detectedAt desc, and paginates", async () => {
    const older = new Date("2026-01-01T00:00:00.000Z");
    const newer = new Date("2026-06-01T00:00:00.000Z");

    const useCase = makeUseCase({
      bookingPaidWithoutTicket: [
        {
          bookingId: "b1",
          bookingCode: "BK1",
          eventId: "e1",
          amount: 1000,
          detectedAt: older,
        },
      ],
      ticketsMissingQr: [
        {
          ticketId: "t1",
          ticketCode: "TK1",
          bookingId: "b2",
          eventId: "e1",
          detectedAt: newer,
        },
      ],
    });

    const result = await useCase.execute({ page: 1, limit: 20 });

    expect(result.summary.bookingPaidWithoutTicket).toBe(1);
    expect(result.summary.ticketMissingQr).toBe(1);
    expect(result.items.items).toHaveLength(2);
    // newest first
    expect(result.items.items[0].type).toBe("ticket_missing_qr");
    expect(result.items.items[1].type).toBe("booking_paid_without_ticket");
  });

  it("respects page/limit for the merged item list", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      ticketId: `t${i}`,
      ticketCode: `TK${i}`,
      bookingId: `b${i}`,
      eventId: "e1",
      detectedAt: new Date(2026, 0, i + 1),
    }));
    const useCase = makeUseCase({ ticketsMissingQr: rows });

    const result = await useCase.execute({ page: 2, limit: 2 });

    expect(result.items.items).toHaveLength(2);
    expect(result.items.meta.totalItems).toBe(5);
    expect(result.items.meta.currentPage).toBe(2);
  });

  it("computes a non-negative minutes-past-expiry detail for stuck bookings", async () => {
    const expiresAt = new Date(Date.now() - 15 * 60 * 1000);
    const useCase = makeUseCase({
      bookingsPendingPastExpiry: [
        {
          bookingId: "b1",
          bookingCode: "BK-STUCK",
          eventId: "e1",
          expiresAt,
          detectedAt: expiresAt,
        },
      ],
    });

    const result = await useCase.execute({ page: 1, limit: 20 });

    expect(result.items.items[0].details).toMatch(/minutes past its expiry/);
  });
});
