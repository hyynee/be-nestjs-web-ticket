import { Injectable } from "@nestjs/common";
import type {
  EventCancellationFailureSource,
  EventCancellationJobDetail,
  EventCancellationJobSource,
} from "../domain/types/event-cancellation.types";

@Injectable()
export class EventCancellationPresenter {
  toFailureView(failure: EventCancellationFailureSource): {
    bookingId: string;
    error: string;
    failedAt: string;
  } {
    return {
      bookingId: failure.bookingId.toString(),
      error: failure.error,
      failedAt: failure.failedAt.toISOString(),
    };
  }

  toDetail(job: EventCancellationJobSource): EventCancellationJobDetail {
    return {
      id: job._id.toString(),
      eventId: job.eventId.toString(),
      initiatedBy: job.initiatedBy.toString(),
      reason: job.reason,
      status: job.status,
      totalBookings: job.totalBookings,
      processedCount: job.processedCount,
      succeededCount: job.succeededCount,
      failedCount: job.failedCount,
      skippedCount: job.skippedCount,
      failures: job.failures.map((failure) => this.toFailureView(failure)),
      ...(job.startedAt ? { startedAt: job.startedAt.toISOString() } : {}),
      ...(job.completedAt
        ? { completedAt: job.completedAt.toISOString() }
        : {}),
      ...(job.createdAt ? { createdAt: job.createdAt.toISOString() } : {}),
      ...(job.updatedAt ? { updatedAt: job.updatedAt.toISOString() } : {}),
    };
  }
}
