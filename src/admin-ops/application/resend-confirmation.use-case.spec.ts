import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BookingStatus } from "@src/schemas/booking.schema";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { ResendConfirmationUseCase } from "./resend-confirmation.use-case";

const admin: JwtPayload = { userId: "admin-1", role: "admin", iat: 0, exp: 0 };

function makeConfirmedBooking(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    bookingCode: "BK-RESEND",
    userId: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    zoneId: new Types.ObjectId(),
    seats: ["A1"],
    quantity: 1,
    totalPrice: 100000,
    customerEmail: "buyer@example.com",
    customerName: "Buyer",
    status: BookingStatus.CONFIRMED,
    snapshot: {
      eventTitle: "My Event",
      eventStartDate: new Date("2026-08-01T10:00:00.000Z"),
      location: "HCMC",
      zoneName: "VIP",
      currency: "vnd",
    },
    ...overrides,
  };
}

function makeNotificationServiceMock() {
  return {
    queueBookingConfirmationEmail: jest.fn().mockResolvedValue(undefined),
    resendBookingConfirmationEmail: jest.fn().mockResolvedValue(undefined),
  };
}

describe("ResendConfirmationUseCase", () => {
  function makeUseCase(
    adminOpsRepository: { loadBookingForResend: jest.Mock },
    ticketModel: { find: jest.Mock },
    notificationService: ReturnType<typeof makeNotificationServiceMock>,
    auditService: { record: jest.Mock }
  ) {
    return new ResendConfirmationUseCase(
      adminOpsRepository as never,
      ticketModel as never,
      notificationService as never,
      auditService as never
    );
  }

  it("throws NotFoundException when the booking does not exist", async () => {
    const adminOpsRepository = {
      loadBookingForResend: jest.fn().mockResolvedValue(null),
    };
    const useCase = makeUseCase(
      adminOpsRepository,
      { find: jest.fn() },
      makeNotificationServiceMock(),
      { record: jest.fn() }
    );

    await expect(useCase.execute("bk-x", admin)).rejects.toThrow(
      NotFoundException
    );
  });

  it("throws BadRequestException when the booking is not confirmed", async () => {
    const adminOpsRepository = {
      loadBookingForResend: jest
        .fn()
        .mockResolvedValue(
          makeConfirmedBooking({ status: BookingStatus.PENDING })
        ),
    };
    const useCase = makeUseCase(
      adminOpsRepository,
      { find: jest.fn() },
      makeNotificationServiceMock(),
      { record: jest.fn() }
    );

    await expect(useCase.execute("bk-x", admin)).rejects.toThrow(
      BadRequestException
    );
  });

  it("throws BadRequestException when the booking has no snapshot (legacy data)", async () => {
    const adminOpsRepository = {
      loadBookingForResend: jest
        .fn()
        .mockResolvedValue(makeConfirmedBooking({ snapshot: undefined })),
    };
    const useCase = makeUseCase(
      adminOpsRepository,
      { find: jest.fn() },
      makeNotificationServiceMock(),
      { record: jest.fn() }
    );

    await expect(useCase.execute("bk-x", admin)).rejects.toThrow(
      BadRequestException
    );
  });

  it("builds the confirmation payload from the snapshot and calls resendBookingConfirmationEmail (NOT queueBookingConfirmationEmail)", async () => {
    const booking = makeConfirmedBooking();
    const adminOpsRepository = {
      loadBookingForResend: jest.fn().mockResolvedValue(booking),
    };
    const leanTickets = [
      { ticketCode: "TK1", seatNumber: "A1", qrCode: "https://qr/TK1.png" },
    ];
    const ticketModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(leanTickets),
      }),
    };
    const notificationService = makeNotificationServiceMock();
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const useCase = makeUseCase(
      adminOpsRepository,
      ticketModel,
      notificationService,
      auditService
    );

    const result = await useCase.execute("bk-resend", admin);

    expect(adminOpsRepository.loadBookingForResend).toHaveBeenCalledWith(
      "BK-RESEND"
    );
    // Regression guard: must go through the resend-specific method, whose
    // per-call idempotencyKey guarantees a new email is actually sent even
    // when the original automatic confirmation email was already queued
    // for this booking — calling queueBookingConfirmationEmail here would
    // silently no-op for any booking that was already confirmed once
    // (see notification-event.service.ts for why).
    expect(
      notificationService.resendBookingConfirmationEmail
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        email: booking.customerEmail,
        bookingCode: booking.bookingCode,
        eventTitle: booking.snapshot.eventTitle,
        zoneName: booking.snapshot.zoneName,
        tickets: [
          { ticketCode: "TK1", seatNumber: "A1", qrCode: "https://qr/TK1.png" },
        ],
      }),
      booking.userId.toString()
    );
    expect(
      notificationService.queueBookingConfirmationEmail
    ).not.toHaveBeenCalled();
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: AuditAction.ADMIN_BOOKING_RESEND_CONFIRMATION,
        bookingId: booking._id.toString(),
      })
    );
    expect(result).toEqual({ bookingCode: "BK-RESEND", status: "queued" });
  });
});
