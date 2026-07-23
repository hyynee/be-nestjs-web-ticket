import { NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { EventCancellationJobStatus } from "@src/schemas/event-cancellation-job.schema";
import { CANCEL_BATCH_SIZE } from "../../event.constants";
import type { EventCancellationJobSource } from "../../domain/types/event-cancellation.types";
import { CancelEventBookingsUseCase } from "./cancel-event-bookings.use-case";

function makeJobSource(
  overrides: Partial<EventCancellationJobSource> = {}
): EventCancellationJobSource {
  return {
    _id: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    initiatedBy: new Types.ObjectId(),
    reason: "Event cancelled by admin",
    status: EventCancellationJobStatus.PENDING,
    totalBookings: 0,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    failures: [],
    ...overrides,
  };
}

/**
 * Stateful fake repository: applyBatchProgress/markProcessing/markCompleted
 * actually mutate the tracked job so the use-case's second loadById() call
 * (used to decide COMPLETED vs COMPLETED_WITH_ERRORS) reflects reality —
 * matches how the real Mongo-backed repository behaves.
 */
function makeFakeRepository(initialJob: EventCancellationJobSource) {
  const state = { ...initialJob };

  return {
    loadById: jest.fn(async () => ({ ...state })),
    loadLatestForEvent: jest.fn(),
    create: jest.fn(),
    markProcessing: jest.fn(async () => {
      state.status = EventCancellationJobStatus.PROCESSING;
    }),
    applyBatchProgress: jest.fn(
      async (
        _id: Types.ObjectId,
        delta: {
          processedCount: number;
          succeededCount: number;
          failedCount: number;
          skippedCount: number;
          lastProcessedBookingId: Types.ObjectId;
          newFailures: Array<{
            bookingId: Types.ObjectId;
            error: string;
            failedAt: Date;
          }>;
        }
      ) => {
        state.processedCount += delta.processedCount;
        state.succeededCount += delta.succeededCount;
        state.failedCount += delta.failedCount;
        state.skippedCount += delta.skippedCount;
        state.lastProcessedBookingId = delta.lastProcessedBookingId;
        state.failures = [...state.failures, ...delta.newFailures];
      }
    ),
    markCompleted: jest.fn(
      async (
        _id: Types.ObjectId,
        status:
          | EventCancellationJobStatus.COMPLETED
          | EventCancellationJobStatus.COMPLETED_WITH_ERRORS
      ) => {
        state.status = status;
      }
    ),
    __state: state,
  };
}

function makeBatchChain(result: unknown[]) {
  return {
    select: jest.fn().mockReturnThis(),
    sort: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  };
}

describe("CancelEventBookingsUseCase", () => {
  const metricsService = {
    eventCancellationBookingsTotal: { inc: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("processes every booking in a single batch and marks the job COMPLETED when all succeed", async () => {
    const job = makeJobSource({ totalBookings: 2 });
    const repository = makeFakeRepository(job);
    const bookingIds = [new Types.ObjectId(), new Types.ObjectId()];
    const bookingModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(
          makeBatchChain(bookingIds.map((id) => ({ _id: id })))
        )
        .mockReturnValueOnce(makeBatchChain([])),
    };
    const bookingService = {
      adminCancelBooking: jest.fn().mockResolvedValue({ message: "ok" }),
    };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(repository.markProcessing).toHaveBeenCalledWith(job._id);
    expect(bookingService.adminCancelBooking).toHaveBeenCalledTimes(2);
    expect(repository.__state.succeededCount).toBe(2);
    expect(repository.__state.failedCount).toBe(0);
    expect(repository.__state.status).toBe(
      EventCancellationJobStatus.COMPLETED
    );
    expect(
      metricsService.eventCancellationBookingsTotal.inc
    ).toHaveBeenCalledWith({ result: "succeeded" }, 2);
  });

  it("continues past a per-booking failure (partial failure) and marks the job COMPLETED_WITH_ERRORS", async () => {
    const job = makeJobSource({ totalBookings: 3 });
    const repository = makeFakeRepository(job);
    const okId1 = new Types.ObjectId();
    const failId = new Types.ObjectId();
    const okId2 = new Types.ObjectId();
    const bookingModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(
          makeBatchChain([{ _id: okId1 }, { _id: failId }, { _id: okId2 }])
        )
        .mockReturnValueOnce(makeBatchChain([])),
    };
    const bookingService = {
      adminCancelBooking: jest.fn().mockImplementation((bookingId: string) => {
        if (bookingId === failId.toString()) {
          return Promise.reject(new Error("Stripe refund API error"));
        }
        return Promise.resolve({ message: "ok" });
      }),
    };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    // The loop must not abort on the failure — both other bookings still processed.
    expect(bookingService.adminCancelBooking).toHaveBeenCalledTimes(3);
    expect(repository.__state.succeededCount).toBe(2);
    expect(repository.__state.failedCount).toBe(1);
    expect(repository.__state.failures).toHaveLength(1);
    expect(repository.__state.failures[0]).toEqual(
      expect.objectContaining({
        bookingId: failId,
        error: "Stripe refund API error",
      })
    );
    expect(repository.__state.status).toBe(
      EventCancellationJobStatus.COMPLETED_WITH_ERRORS
    );
    expect(
      metricsService.eventCancellationBookingsTotal.inc
    ).toHaveBeenCalledWith({ result: "failed" }, 1);
  });

  it("treats an already-cancelled/expired booking (NotFoundException) as SKIPPED, not FAILED", async () => {
    const job = makeJobSource({ totalBookings: 1 });
    const repository = makeFakeRepository(job);
    const bookingId = new Types.ObjectId();
    const bookingModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(makeBatchChain([{ _id: bookingId }]))
        .mockReturnValueOnce(makeBatchChain([])),
    };
    const bookingService = {
      adminCancelBooking: jest
        .fn()
        .mockRejectedValue(
          new NotFoundException(
            "Booking not found or already cancelled/expired"
          )
        ),
    };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(repository.__state.skippedCount).toBe(1);
    expect(repository.__state.failedCount).toBe(0);
    expect(repository.__state.failures).toHaveLength(0);
    // A run that only skips already-done bookings has no real failures.
    expect(repository.__state.status).toBe(
      EventCancellationJobStatus.COMPLETED
    );
  });

  it("resumes from lastProcessedBookingId instead of restarting the cursor from the beginning", async () => {
    const checkpoint = new Types.ObjectId();
    const job = makeJobSource({
      totalBookings: 10,
      processedCount: 4,
      succeededCount: 4,
      lastProcessedBookingId: checkpoint,
    });
    const repository = makeFakeRepository(job);
    const bookingModel = {
      find: jest.fn().mockReturnValue(makeBatchChain([])),
    };
    const bookingService = { adminCancelBooking: jest.fn() };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(bookingModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ _id: { $gt: checkpoint } })
    );
  });

  it("is idempotent: a duplicate execution of an already-COMPLETED job is a no-op", async () => {
    const job = makeJobSource({
      status: EventCancellationJobStatus.COMPLETED,
      totalBookings: 5,
      succeededCount: 5,
    });
    const repository = makeFakeRepository(job);
    const bookingModel = { find: jest.fn() };
    const bookingService = { adminCancelBooking: jest.fn() };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(bookingModel.find).not.toHaveBeenCalled();
    expect(repository.markProcessing).not.toHaveBeenCalled();
    expect(bookingService.adminCancelBooking).not.toHaveBeenCalled();
  });

  it("is idempotent: a duplicate execution of an already-COMPLETED_WITH_ERRORS job is a no-op", async () => {
    const job = makeJobSource({
      status: EventCancellationJobStatus.COMPLETED_WITH_ERRORS,
    });
    const repository = makeFakeRepository(job);
    const bookingModel = { find: jest.fn() };
    const bookingService = { adminCancelBooking: jest.fn() };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(bookingModel.find).not.toHaveBeenCalled();
  });

  it("paginates across multiple batches using CANCEL_BATCH_SIZE, checkpointing after each", async () => {
    const job = makeJobSource({ totalBookings: CANCEL_BATCH_SIZE + 5 });
    const repository = makeFakeRepository(job);
    const firstBatch = Array.from({ length: CANCEL_BATCH_SIZE }, () => ({
      _id: new Types.ObjectId(),
    }));
    const secondBatch = Array.from({ length: 5 }, () => ({
      _id: new Types.ObjectId(),
    }));
    const bookingModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(makeBatchChain(firstBatch))
        .mockReturnValueOnce(makeBatchChain(secondBatch))
        .mockReturnValueOnce(makeBatchChain([])),
    };
    const bookingService = {
      adminCancelBooking: jest.fn().mockResolvedValue({ message: "ok" }),
    };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(bookingService.adminCancelBooking).toHaveBeenCalledTimes(
      CANCEL_BATCH_SIZE + 5
    );
    // Checkpoint applied once per non-empty batch (2 batches here).
    expect(repository.applyBatchProgress).toHaveBeenCalledTimes(2);
    expect(repository.__state.succeededCount).toBe(CANCEL_BATCH_SIZE + 5);
    expect(repository.__state.status).toBe(
      EventCancellationJobStatus.COMPLETED
    );
  });

  it("passes the job's initiatedBy and reason through to adminCancelBooking for every booking", async () => {
    const initiatedBy = new Types.ObjectId();
    const job = makeJobSource({
      totalBookings: 1,
      initiatedBy,
      reason: "Venue double-booked",
    });
    const repository = makeFakeRepository(job);
    const bookingId = new Types.ObjectId();
    const bookingModel = {
      find: jest
        .fn()
        .mockReturnValueOnce(makeBatchChain([{ _id: bookingId }]))
        .mockReturnValueOnce(makeBatchChain([])),
    };
    const bookingService = {
      adminCancelBooking: jest.fn().mockResolvedValue({ message: "ok" }),
    };

    const useCase = new CancelEventBookingsUseCase(
      bookingModel as never,
      repository as never,
      bookingService as never,
      metricsService as never
    );

    await useCase.execute(job._id.toString());

    expect(bookingService.adminCancelBooking).toHaveBeenCalledWith(
      bookingId.toString(),
      initiatedBy.toString(),
      "Venue double-booked"
    );
  });
});
