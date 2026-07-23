import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { BookingService } from "@src/booking/booking.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { MetricsService } from "@src/metrics/metrics.service";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import {
  EventCancellationFailure,
  EventCancellationJobStatus,
} from "@src/schemas/event-cancellation-job.schema";
import { FilterQuery, Model, Types } from "mongoose";
import { CANCEL_BATCH_SIZE } from "../../event.constants";
import { EventCancellationJobRepository } from "../../infrastructure/persistence/event-cancellation-job.repository";

/**
 * Worker-side execution of a bulk event cancellation
 * (production-readiness-audit-2026-07-22.md NEW#6). Runs inside the BullMQ
 * "default" queue, never on the HTTP request thread — see
 * EventLifecycleService.cancelEventWithRefund for the synchronous entry
 * point that only flips the event status and enqueues this job.
 *
 * Resumable: progress is checkpointed to Mongo after every batch via
 * lastProcessedBookingId, so a BullMQ retry (or an admin-triggered retry of
 * the same job) continues the cursor scan from where it left off instead of
 * restarting. Reprocessing an already-cancelled booking is also safe on its
 * own — AdminCancelBookingUseCase's own status guard throws NotFoundException
 * for it, which this treats as "skipped", not "failed".
 */
@Injectable()
export class CancelEventBookingsUseCase {
  private readonly logger = new Logger(CancelEventBookingsUseCase.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly repository: EventCancellationJobRepository,
    private readonly bookingService: BookingService,
    private readonly metricsService: MetricsService
  ) {}

  async execute(cancellationJobId: string): Promise<void> {
    const job = await this.repository.loadById(cancellationJobId);

    if (
      job.status === EventCancellationJobStatus.COMPLETED ||
      job.status === EventCancellationJobStatus.COMPLETED_WITH_ERRORS
    ) {
      this.logger.log(
        `cancel-event-bookings: job=${cancellationJobId} already ${job.status} — skipping duplicate execution`
      );
      return;
    }

    await this.repository.markProcessing(job._id);

    let lastId: Types.ObjectId | null = job.lastProcessedBookingId ?? null;

    for (;;) {
      const filter: FilterQuery<Booking> = {
        eventId: job.eventId,
        status: { $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED] },
        isDeleted: false,
      };
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await this.bookingModel
        .find(filter)
        .select("_id")
        .sort({ _id: 1 })
        .limit(CANCEL_BATCH_SIZE)
        .lean();

      if (!batch.length) {
        break;
      }

      let batchSucceeded = 0;
      let batchFailed = 0;
      let batchSkipped = 0;
      const batchFailures: EventCancellationFailure[] = [];

      for (const booking of batch) {
        const bookingObjectId = booking._id as Types.ObjectId;
        const bookingId = bookingObjectId.toString();
        try {
          await this.bookingService.adminCancelBooking(
            bookingId,
            job.initiatedBy.toString(),
            job.reason
          );
          batchSucceeded++;
        } catch (err) {
          if (err instanceof NotFoundException) {
            // Booking was already cancelled/expired by the time we got to
            // it — expected on resume after a prior partial run, not a
            // real failure.
            batchSkipped++;
            continue;
          }
          const msg = getErrorMessage(err);
          this.logger.error(
            `cancel-event-bookings: job=${cancellationJobId} failed booking=${bookingId} error="${msg}"`
          );
          batchFailed++;
          batchFailures.push({
            bookingId: bookingObjectId,
            error: msg,
            failedAt: new Date(),
          } as EventCancellationFailure);
        }
      }

      const lastBatchId = batch[batch.length - 1]._id as Types.ObjectId;
      await this.repository.applyBatchProgress(job._id, {
        processedCount: batch.length,
        succeededCount: batchSucceeded,
        failedCount: batchFailed,
        skippedCount: batchSkipped,
        lastProcessedBookingId: lastBatchId,
        newFailures: batchFailures,
      });

      if (batchSucceeded > 0) {
        this.metricsService.eventCancellationBookingsTotal.inc(
          { result: "succeeded" },
          batchSucceeded
        );
      }
      if (batchFailed > 0) {
        this.metricsService.eventCancellationBookingsTotal.inc(
          { result: "failed" },
          batchFailed
        );
      }
      if (batchSkipped > 0) {
        this.metricsService.eventCancellationBookingsTotal.inc(
          { result: "skipped" },
          batchSkipped
        );
      }

      lastId = lastBatchId;
      if (batch.length < CANCEL_BATCH_SIZE) {
        break;
      }
    }

    const finalJob = await this.repository.loadById(cancellationJobId);
    const finalStatus =
      finalJob.failedCount > 0
        ? EventCancellationJobStatus.COMPLETED_WITH_ERRORS
        : EventCancellationJobStatus.COMPLETED;
    await this.repository.markCompleted(job._id, finalStatus);

    this.logger.log(
      `cancel-event-bookings: job=${cancellationJobId} done status=${finalStatus} processed=${finalJob.processedCount} succeeded=${finalJob.succeededCount} failed=${finalJob.failedCount} skipped=${finalJob.skippedCount}`
    );
  }
}
