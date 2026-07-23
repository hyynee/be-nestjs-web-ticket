import { Types } from "mongoose";
import { BookingStatus } from "@src/schemas/booking.schema";
import { CancelPaymentUseCase } from "./cancel-payment.use-case";

describe("CancelPaymentUseCase", () => {
  const userId = new Types.ObjectId().toString();
  const bookingCode = "BOOK123";
  const zoneId = new Types.ObjectId();

  function makeUseCase(
    opts: {
      bookingFound?: boolean;
      releaseUsageError?: Error;
    } = {}
  ) {
    const bookingFound = opts.bookingFound ?? true;
    const bookingId = new Types.ObjectId();
    const cancelledBooking = {
      _id: bookingId,
      bookingCode,
      zoneId,
      quantity: 2,
      status: BookingStatus.CANCELLED,
    };

    const session = {
      withTransaction: jest
        .fn()
        .mockImplementation(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const bookingModel = {
      db: { startSession: jest.fn().mockResolvedValue(session) },
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValue(bookingFound ? cancelledBooking : null),
    };

    const zoneModel = {
      updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: zoneId,
            eventId: new Types.ObjectId(),
            capacity: 100,
            soldCount: 10,
            confirmedSoldCount: 5,
          }),
        }),
      }),
    };

    const zoneGateway = { emitZoneTicketUpdate: jest.fn() };
    const zoneService = {
      invalidateZoneAvailabilityCache: jest.fn().mockResolvedValue(undefined),
    };
    const promotionService = {
      releaseUsageForBooking: opts.releaseUsageError
        ? jest.fn().mockRejectedValue(opts.releaseUsageError)
        : jest.fn().mockResolvedValue(undefined),
    };
    const paymentPresenter = {
      paymentCancelResult: jest.fn((message: string) => ({ message })),
    };

    const useCase = new CancelPaymentUseCase(
      bookingModel as never,
      zoneModel as never,
      zoneGateway as never,
      zoneService as never,
      promotionService as never,
      paymentPresenter as never
    );

    return {
      useCase,
      session,
      bookingModel,
      zoneModel,
      zoneGateway,
      zoneService,
      promotionService,
      bookingId,
    };
  }

  it("invalidates the zone availability cache after cancelling a pending payment (PRE-7)", async () => {
    const { useCase, zoneService } = makeUseCase();

    await useCase.execute(userId, bookingCode);

    expect(zoneService.invalidateZoneAvailabilityCache).toHaveBeenCalledWith(
      zoneId
    );
  });

  it("does NOT touch the zone cache when no matching pending booking is found", async () => {
    const { useCase, zoneService } = makeUseCase({ bookingFound: false });

    await useCase.execute(userId, bookingCode);

    expect(zoneService.invalidateZoneAvailabilityCache).not.toHaveBeenCalled();
  });

  it("still ends the DB session even when no booking matches", async () => {
    const { useCase, session } = makeUseCase({ bookingFound: false });

    await useCase.execute(userId, bookingCode);

    expect(session.endSession).toHaveBeenCalledTimes(1);
  });

  describe("HIGH fix: promo quota leak", () => {
    it("releases promotion usage for the cancelled booking, inside the same session, after cancelling a pending payment", async () => {
      const { useCase, session, promotionService, bookingId } = makeUseCase();

      await useCase.execute(userId, bookingCode);

      expect(promotionService.releaseUsageForBooking).toHaveBeenCalledWith(
        bookingId,
        session
      );
    });

    it("does NOT call releaseUsageForBooking when no matching pending booking is found", async () => {
      const { useCase, promotionService } = makeUseCase({
        bookingFound: false,
      });

      await useCase.execute(userId, bookingCode);

      expect(promotionService.releaseUsageForBooking).not.toHaveBeenCalled();
    });

    it("aborts the transaction and rethrows when releaseUsageForBooking fails — booking must never end up cancelled with promo quota left dangling", async () => {
      const releaseError = new Error("Mongo write conflict");
      const { useCase, zoneModel, zoneService, zoneGateway, promotionService } =
        makeUseCase({ releaseUsageError: releaseError });

      await expect(useCase.execute(userId, bookingCode)).rejects.toThrow(
        "Mongo write conflict"
      );

      expect(promotionService.releaseUsageForBooking).toHaveBeenCalled();
      // zoneModel.updateOne DID run before the throw (same transaction), but
      // since the transaction as a whole rejects, withTransaction's own
      // abort semantics roll it back — the post-commit side effects below
      // must never run for a transaction that never actually committed.
      expect(zoneModel.updateOne).toHaveBeenCalled();
      expect(
        zoneService.invalidateZoneAvailabilityCache
      ).not.toHaveBeenCalled();
      expect(zoneGateway.emitZoneTicketUpdate).not.toHaveBeenCalled();
    });

    it("calls releaseUsageForBooking from inside withTransaction, before the transaction resolves", async () => {
      const { useCase, session, promotionService } = makeUseCase();
      const callOrder: string[] = [];
      session.withTransaction.mockImplementation(
        async (fn: () => Promise<void>) => {
          await fn();
          callOrder.push("withTransaction resolved");
        }
      );
      (promotionService.releaseUsageForBooking as jest.Mock).mockImplementation(
        async () => {
          callOrder.push("releaseUsageForBooking called");
        }
      );

      await useCase.execute(userId, bookingCode);

      expect(callOrder).toEqual([
        "releaseUsageForBooking called",
        "withTransaction resolved",
      ]);
    });
  });
});
