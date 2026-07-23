import { Types } from "mongoose";
import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";
import { CancelTicketUseCase } from "./cancel-ticket.use-case";

describe("CancelTicketUseCase", () => {
  const userId = new Types.ObjectId().toString();
  const ticketCode = "TICKET123";
  const zoneId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();

  function makeUseCase(
    opts: {
      bookingStatus?: BookingStatus;
      paymentStatus?: PaymentStatus;
      remainingValidTickets?: number;
    } = {}
  ) {
    const bookingStatus = opts.bookingStatus ?? BookingStatus.PENDING;
    const paymentStatus = opts.paymentStatus ?? PaymentStatus.UNPAID;
    const remainingValidTickets = opts.remainingValidTickets ?? 0;

    const cancelledTicket = {
      _id: new Types.ObjectId(),
      ticketCode,
      bookingId,
      zoneId,
      status: "cancelled",
    };

    const session = {
      withTransaction: jest
        .fn()
        .mockImplementation(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const ticketModel = {
      db: { startSession: jest.fn().mockResolvedValue(session) },
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ bookingId }),
          }),
        }),
      }),
      findOneAndUpdate: jest.fn().mockResolvedValue(cancelledTicket),
      countDocuments: jest.fn().mockResolvedValue(remainingValidTickets),
    };

    const bookingModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockReturnValue({
            lean: jest
              .fn()
              .mockResolvedValue({ status: bookingStatus, paymentStatus }),
          }),
        }),
      }),
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };

    const zoneModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
    };
    const ticketCache = {
      invalidateTicketCache: jest.fn().mockResolvedValue(undefined),
      invalidateUserTicketCache: jest.fn().mockResolvedValue(undefined),
    };
    const ticketQrService = {
      deleteQRCode: jest.fn().mockResolvedValue(undefined),
    };
    const ticketPresenter = {
      ticketCancelResult: jest.fn((code: string, ticket: unknown) => ({
        code,
        ticket,
      })),
    };
    const zoneService = {
      invalidateZoneAvailabilityCache: jest.fn().mockResolvedValue(undefined),
    };

    const useCase = new CancelTicketUseCase(
      ticketModel as never,
      bookingModel as never,
      zoneModel as never,
      ticketCache as never,
      ticketQrService as never,
      ticketPresenter as never,
      zoneService as never
    );

    return { useCase, session, zoneModel, ticketCache, zoneService };
  }

  it("invalidates the zone availability cache after cancelling a valid ticket (PRE-7)", async () => {
    const { useCase, zoneService } = makeUseCase();

    await useCase.execute(ticketCode, userId);

    expect(zoneService.invalidateZoneAvailabilityCache).toHaveBeenCalledWith(
      zoneId
    );
  });

  it("also invalidates zone cache when other valid tickets remain on the booking", async () => {
    const { useCase, zoneService } = makeUseCase({
      remainingValidTickets: 2,
    });

    await useCase.execute(ticketCode, userId);

    expect(zoneService.invalidateZoneAvailabilityCache).toHaveBeenCalledWith(
      zoneId
    );
  });
});
