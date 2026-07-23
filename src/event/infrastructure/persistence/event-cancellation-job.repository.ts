import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  EventCancellationFailure,
  EventCancellationJob,
  EventCancellationJobStatus,
} from "@src/schemas/event-cancellation-job.schema";
import { Model, Types } from "mongoose";
import type { EventCancellationJobSource } from "../../domain/types/event-cancellation.types";

export const EVENT_CANCELLATION_FAILURE_LOG_CAP = 200;

export type BatchProgressDelta = {
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  lastProcessedBookingId: Types.ObjectId;
  newFailures: EventCancellationFailure[];
};

@Injectable()
export class EventCancellationJobRepository {
  constructor(
    @InjectModel(EventCancellationJob.name)
    private readonly model: Model<EventCancellationJob>
  ) {}

  async create(input: {
    id: Types.ObjectId;
    eventId: Types.ObjectId;
    initiatedBy: Types.ObjectId;
    reason: string;
    totalBookings: number;
    queueJobId: string;
  }): Promise<EventCancellationJobSource> {
    const [created] = await this.model.create([
      {
        _id: input.id,
        eventId: input.eventId,
        initiatedBy: input.initiatedBy,
        reason: input.reason,
        totalBookings: input.totalBookings,
        queueJobId: input.queueJobId,
        status: EventCancellationJobStatus.PENDING,
      },
    ]);
    return created.toObject() as EventCancellationJobSource;
  }

  async loadById(id: string): Promise<EventCancellationJobSource> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException("Cancellation job not found");
    }
    const job = await this.model
      .findOne({ _id: id, isDeleted: false })
      .lean<EventCancellationJobSource>();
    if (!job) {
      throw new NotFoundException("Cancellation job not found");
    }
    return job;
  }

  async loadLatestForEvent(
    eventId: string
  ): Promise<EventCancellationJobSource | null> {
    if (!Types.ObjectId.isValid(eventId)) {
      return null;
    }
    return this.model
      .findOne({ eventId: new Types.ObjectId(eventId), isDeleted: false })
      .sort({ createdAt: -1 })
      .lean<EventCancellationJobSource>();
  }

  async markProcessing(id: Types.ObjectId): Promise<void> {
    await this.model.updateOne(
      { _id: id, status: EventCancellationJobStatus.PENDING },
      {
        $set: {
          status: EventCancellationJobStatus.PROCESSING,
          startedAt: new Date(),
        },
      }
    );
  }

  /**
   * Applies one batch's outcome atomically: increments the running counts,
   * advances the resume checkpoint, and appends any new failures — capped
   * at EVENT_CANCELLATION_FAILURE_LOG_CAP via $slice so a pathological
   * event can't grow this document unboundedly (rule.md 6.5 backpressure).
   */
  async applyBatchProgress(
    id: Types.ObjectId,
    delta: BatchProgressDelta
  ): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      {
        $inc: {
          processedCount: delta.processedCount,
          succeededCount: delta.succeededCount,
          failedCount: delta.failedCount,
          skippedCount: delta.skippedCount,
        },
        $set: { lastProcessedBookingId: delta.lastProcessedBookingId },
        ...(delta.newFailures.length > 0
          ? {
              $push: {
                failures: {
                  $each: delta.newFailures,
                  $slice: -EVENT_CANCELLATION_FAILURE_LOG_CAP,
                },
              },
            }
          : {}),
      }
    );
  }

  async markCompleted(
    id: Types.ObjectId,
    status:
      | EventCancellationJobStatus.COMPLETED
      | EventCancellationJobStatus.COMPLETED_WITH_ERRORS
  ): Promise<void> {
    await this.model.updateOne(
      { _id: id },
      { $set: { status, completedAt: new Date() } }
    );
  }
}
