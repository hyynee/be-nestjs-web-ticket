import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";
import { RefundRequestStatus } from "@src/schemas/refund-request.schema";
import { RefundableBooking } from "../domain/types/refund-domain.types";
import { CreateRefundRequestUseCase } from "./create-refund-request.use-case";

const user: JwtPayload = {
  userId: "507f1f77bcf86cd799439011",
  role: "user",
  iat: 0,
  exp: 0,
};

function makeBooking(
  overrides: Partial<RefundableBooking> = {}
): RefundableBooking {
  return {
    _id: new Types.ObjectId(),
    bookingCode: "BK1",
    userId: new Types.ObjectId(user.userId),
    eventId: new Types.ObjectId(),
    zoneId: new Types.ObjectId(),
    quantity: 2,
    totalPrice: 100000,
    totalRefunded: 0,
    status: BookingStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    ...overrides,
  };
}

describe("CreateRefundRequestUseCase", () => {
  function makeUseCase(overrides: {
    booking?: RefundableBooking;
    usedTicketCount?: number;
    createError?: unknown;
  }) {
    const booking = overrides.booking ?? makeBooking();
    const created = {
      _id: new Types.ObjectId(),
      bookingId: booking._id,
      userId: booking.userId,
      eventId: booking.eventId,
      amount: 100000,
      reason: "changed my mind",
      status: RefundRequestStatus.REQUESTED,
    };

    const repository = {
      loadBookingByCode: jest.fn().mockResolvedValue(booking),
      createRequest: overrides.createError
        ? jest.fn().mockRejectedValue(overrides.createError)
        : jest.fn().mockResolvedValue([created]),
    };
    const policy = {
      assertRequestOwner: jest.fn(),
      assertBookingRefundable: jest.fn(),
      resolveRefundAmount: jest.fn().mockReturnValue(100000),
    };
    const presenter = {
      toDetail: jest.fn((row: unknown) => ({
        ...(row as object),
        presented: true,
      })),
    };
    const ticketModel = {
      countDocuments: jest
        .fn()
        .mockResolvedValue(overrides.usedTicketCount ?? 0),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const notificationService = {
      notifyRefundRequested: jest.fn().mockResolvedValue(undefined),
    };

    const useCase = new CreateRefundRequestUseCase(
      repository as never,
      policy as never,
      presenter as never,
      ticketModel as never,
      auditService as never,
      notificationService as never
    );

    return {
      useCase,
      repository,
      policy,
      presenter,
      ticketModel,
      auditService,
      notificationService,
      booking,
      created,
    };
  }

  it("validates ownership, refundability, and amount in order before creating the request", async () => {
    const { useCase, repository, policy, auditService, notificationService } =
      makeUseCase({});

    await useCase.execute(user, { bookingCode: "bk1", reason: "changed mind" });

    expect(repository.loadBookingByCode).toHaveBeenCalledWith("bk1");
    expect(policy.assertRequestOwner).toHaveBeenCalled();
    expect(policy.assertBookingRefundable).toHaveBeenCalled();
    expect(policy.resolveRefundAmount).toHaveBeenCalled();
    expect(repository.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        status: RefundRequestStatus.REQUESTED,
        amount: 100000,
        reason: "changed mind",
      })
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.REFUND_REQUESTED })
    );
    expect(notificationService.notifyRefundRequested).toHaveBeenCalled();
  });

  it("records whether the booking has used (checked-in) tickets in the request metadata", async () => {
    const { useCase, repository } = makeUseCase({ usedTicketCount: 1 });

    await useCase.execute(user, { bookingCode: "bk1", reason: "x" });

    expect(repository.createRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          usedTicketCount: 1,
          hasUsedTickets: true,
        }),
      })
    );
  });

  it("propagates ForbiddenException when the requester does not own the booking", async () => {
    const { useCase, policy } = makeUseCase({});
    policy.assertRequestOwner.mockImplementation(() => {
      throw new ForbiddenException();
    });

    await expect(
      useCase.execute(user, { bookingCode: "bk1", reason: "x" })
    ).rejects.toThrow(ForbiddenException);
  });

  it("propagates BadRequestException when the booking is not refundable", async () => {
    const { useCase, policy } = makeUseCase({});
    policy.assertBookingRefundable.mockImplementation(() => {
      throw new BadRequestException();
    });

    await expect(
      useCase.execute(user, { bookingCode: "bk1", reason: "x" })
    ).rejects.toThrow(BadRequestException);
  });

  it("maps a duplicate-key error (unique active-request-per-booking index) to a 409 Conflict", async () => {
    const { useCase } = makeUseCase({ createError: { code: 11000 } });

    await expect(
      useCase.execute(user, { bookingCode: "bk1", reason: "x" })
    ).rejects.toThrow(ConflictException);
  });

  it("re-throws non-duplicate-key errors from the repository unchanged", async () => {
    const { useCase } = makeUseCase({ createError: new Error("db down") });

    await expect(
      useCase.execute(user, { bookingCode: "bk1", reason: "x" })
    ).rejects.toThrow("db down");
  });
});
