import {
  Processor,
  WorkerHost,
  OnWorkerEvent,
  InjectQueue,
} from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { Injectable, Logger } from "@nestjs/common";
import { CancelEventBookingsUseCase } from "@src/event/application/use-case/cancel-event-bookings.use-case";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import type { CancelEventBookingsJobPayload } from "@src/event/domain/types/event-cancellation.types";
import { FAILED_JOB_ALERT_THRESHOLD } from "./queue.service";
import {
  DEAD_LETTER_QUEUE_NAME,
  EVENT_CANCELLATION_JOB_TYPE,
  EVENT_CANCELLATION_QUEUE_NAME,
} from "./queue.constants";

/**
 * Dedicated worker lane for `cancel-event-bookings` (HIGH — event
 * cancellation queue starvation, production-readiness-audit-2026-07-23.md).
 * A `@Processor(queueName)` gets its own independent BullMQ Worker — running
 * this job type here, instead of on `QueueProcessor`'s `default` worker,
 * means a large event's long sequential cancel loop can no longer occupy
 * the same worker slot that refund-failure-alert/email/ticket-delivery/
 * notification jobs depend on. Retry/backoff/dead-letter behavior mirrors
 * `QueueProcessor` exactly (same DLQ, same alert-threshold semantics) —
 * only the worker lane changed, not the reliability contract.
 */
@Processor(EVENT_CANCELLATION_QUEUE_NAME)
@Injectable()
export class EventCancellationQueueProcessor extends WorkerHost {
  private readonly logger = new Logger(EventCancellationQueueProcessor.name);

  constructor(
    private readonly cancelEventBookingsUseCase: CancelEventBookingsUseCase,
    @InjectQueue(EVENT_CANCELLATION_QUEUE_NAME) private readonly queue: Queue,
    @InjectQueue(DEAD_LETTER_QUEUE_NAME) private readonly dlqQueue: Queue
  ) {
    super();
  }

  async process(job: Job): Promise<boolean> {
    try {
      if (!job.data || !job.data.type) {
        throw new Error("Invalid job data");
      }
      const { type, payload } = job.data;
      if (type !== EVENT_CANCELLATION_JOB_TYPE) {
        throw new Error(`Unknown job type: ${type as string}`);
      }

      const { cancellationJobId } = payload as CancelEventBookingsJobPayload;
      await this.cancelEventBookingsUseCase.execute(cancellationJobId);
      return true;
    } catch (error) {
      this.logger.error(
        `Job failed — id=${job.id}, type=${job.data?.type}, attempt=${job.attemptsMade}: ${getErrorMessage(error)}`
      );
      throw error;
    }
  }

  @OnWorkerEvent("failed")
  async onFailed(job: Job, error: Error): Promise<void> {
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      return;
    }

    try {
      await this.dlqQueue.add(
        "dead-letter",
        {
          originalJobId: job.id,
          originalName: job.name,
          originalType: job.data?.type,
          payload: job.data,
          error: error.message,
          stack: error.stack,
          attemptsMade: job.attemptsMade,
          failedAt: new Date().toISOString(),
        },
        {
          jobId: `dead-letter-${job.id ?? `${job.data?.type}-${Date.now()}`}`,
          removeOnComplete: false,
          removeOnFail: false,
        }
      );

      const counts = await this.queue.getJobCounts("failed");
      const failedCount = counts.failed ?? 0;
      if (failedCount > FAILED_JOB_ALERT_THRESHOLD) {
        this.logger.error(
          `[QueueAlert] permanently failed jobs=${failedCount} exceeded threshold=${FAILED_JOB_ALERT_THRESHOLD} — type=${job.data?.type}, jobId=${job.id}, error="${error.message}"`
        );
      } else {
        this.logger.warn(
          `Job permanently failed — id=${job.id}, type=${job.data?.type}, totalFailed=${failedCount}, error="${error.message}"`
        );
      }
    } catch (alertError) {
      this.logger.warn(
        `Job permanently failed — id=${job.id}, type=${job.data?.type}, error="${error.message}" (failed count unavailable: ${getErrorMessage(alertError)})`
      );
    }
  }
}
