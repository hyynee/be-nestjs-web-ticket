import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { randomUUID } from "crypto";
import { QueryJobDto, QUEUE_JOB_STATUSES } from "./dto/query-job.dto";
import { sanitizeSensitiveFields } from "@src/helper/sanitize.helper";
import { getErrorMessage } from "@src/helper/getErrorMessage";

export const FAILED_JOB_RETAIN_COUNT = 1000;
export const FAILED_JOB_ALERT_THRESHOLD = 100;

export interface QueueJobSummary {
  id: string;
  name: string;
  type: string | undefined;
  status: string;
  attemptsMade: number;
  timestamp: number | undefined;
  processedOn: number | undefined;
  finishedOn: number | undefined;
  failedReason: string | undefined;
}

export interface QueueJobDetail extends QueueJobSummary {
  data: unknown;
  stacktrace: string[] | undefined;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue("default") private readonly queue: Queue,
    @InjectQueue("dead-letter") private readonly dlqQueue: Queue
  ) {}

  async getJobCounts() {
    return this.queue.getJobCounts("active", "waiting", "failed", "delayed");
  }

  async addJob(
    data: {
      type: string;
      payload?: unknown;
      [key: string]: unknown;
    },
    options?: { jobId?: string }
  ) {
    const isRefundAlert = data.type === "refund-failure-alert";
    const jobId = options?.jobId ?? this.buildJobId(data);

    return this.queue.add("default", data, {
      ...(jobId ? { jobId } : {}),
      attempts: isRefundAlert ? 6 : 3,
      priority: isRefundAlert ? 1 : 10,
      backoff: {
        type: "exponential",
        delay: isRefundAlert ? 10_000 : 5_000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: FAILED_JOB_RETAIN_COUNT },
    });
  }

  /** Admin-facing wrapper around {@link addJob} — payload already DTO-validated by controller. */
  async addAdminJob(data: { type: string; payload: Record<string, unknown> }) {
    return this.addJob(data);
  }

  async getQueueStats() {
    const [defaultCounts, deadLetterCounts] = await Promise.all([
      this.queue.getJobCounts(
        "active",
        "waiting",
        "failed",
        "delayed",
        "completed"
      ),
      this.dlqQueue.getJobCounts("waiting", "failed", "completed"),
    ]);

    return {
      default: defaultCounts,
      deadLetter: deadLetterCounts,
    };
  }

  async listJobs(query: QueryJobDto): Promise<{
    data: QueueJobSummary[];
    page: number;
    limit: number;
    total: number;
  }> {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const queueName = query.queue ?? "default";
    const targetQueue =
      queueName === "dead-letter" ? this.dlqQueue : this.queue;

    const start = (page - 1) * limit;
    const end = start + limit - 1;

    const types = query.status ? [query.status] : [...QUEUE_JOB_STATUSES];
    const [jobs, counts] = await Promise.all([
      targetQueue.getJobs(types, start, end, false),
      targetQueue.getJobCounts(...types),
    ]);

    const total = query.status
      ? (counts[query.status] ?? 0)
      : Object.values(counts).reduce((sum, n) => sum + (n ?? 0), 0);

    const data = await Promise.all(jobs.map((job) => this.toSummary(job)));

    return { data, page, limit, total };
  }

  async getJob(id: string): Promise<QueueJobDetail> {
    const job = await this.findJobAnywhere(id);
    const state = await job.getState();
    const summary = await this.toSummary(job, state);

    return {
      ...summary,
      data: sanitizeSensitiveFields(job.data),
      stacktrace: job.stacktrace?.length ? job.stacktrace : undefined,
    };
  }

  async retryJob(id: string): Promise<{ id: string; retried: boolean }> {
    const job = await this.queue.getJob(id);

    if (job) {
      await this.retryExistingJob(job);
      return { id, retried: true };
    }

    const dlqJob = await this.dlqQueue.getJob(id);
    if (!dlqJob) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    // DLQ entries store the full original job data (`{ type, payload }`) under
    // their own `payload` field — re-enqueue it as-is, do not re-wrap it.
    const originalJobData = dlqJob.data?.payload as
      { type?: string; payload?: unknown; [key: string]: unknown } | undefined;
    if (!originalJobData?.type) {
      throw new BadRequestException(
        "Dead-letter entry missing original job type — cannot re-enqueue"
      );
    }

    const originalJobId = dlqJob.data?.originalJobId as string | undefined;
    const originalJob = originalJobId
      ? await this.queue.getJob(originalJobId)
      : undefined;

    if (originalJob) {
      // The original job can still be sitting in the default queue — BullMQ
      // retains failed jobs up to FAILED_JOB_RETAIN_COUNT before eviction.
      // Retry it in place: re-adding with the same deduped jobId (e.g. for
      // send-password-reset/send-booking-confirmation/finalize-ticket-delivery/
      // refund-failure-alert) would silently no-op against the still-existing
      // job instead of creating a fresh attempt, making this look like a
      // successful retry when nothing actually reprocessed.
      await this.retryExistingJob(originalJob);
    } else {
      // Original job was already evicted — re-enqueue fresh, forcing a unique
      // jobId so a deduped job type can't collide with an id that, by
      // definition, no longer resolves to anything real.
      await this.addJob(
        originalJobData as { type: string; payload?: unknown },
        {
          jobId: `retry:${originalJobId ?? id}:${Date.now()}`,
        }
      );
    }

    await dlqJob.remove();

    return { id, retried: true };
  }

  private async retryExistingJob(job: Job): Promise<void> {
    const state = await job.getState();
    if (state !== "failed" && state !== "completed") {
      throw new BadRequestException(
        `Job is in state "${state}" — only failed or completed jobs can be retried`
      );
    }
    await job.retry(state);
  }

  async moveToDeadLetter(
    id: string,
    reason?: string
  ): Promise<{ id: string; moved: boolean }> {
    const job = await this.queue.getJob(id);
    if (!job) {
      throw new NotFoundException(`Job ${id} not found in default queue`);
    }

    const state = await job.getState();
    if (state === "active") {
      throw new BadRequestException(
        "Job is currently being processed — wait for it to finish or fail before moving to dead-letter"
      );
    }

    const dlqPayload = {
      originalJobId: job.id,
      originalName: job.name,
      originalType: job.data?.type,
      payload: job.data,
      error: reason ?? "Manually moved to dead-letter by admin",
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };
    const dlqJobId = `dead-letter:${job.id ?? `${job.data?.type}:${Date.now()}`}`;

    // Write the dead-letter copy first, using a deterministic jobId so a retry
    // of this same move never creates a second copy. Only remove the source
    // job from the default queue once the copy is durably persisted — if
    // remove() then fails (e.g. the job got picked up and locked by a worker
    // in the meantime), roll back the copy we just wrote instead of leaving
    // the job permanently lost from both queues.
    const dlqJob = await this.dlqQueue.add("dead-letter", dlqPayload, {
      jobId: dlqJobId,
      removeOnComplete: false,
      removeOnFail: false,
    });

    try {
      await job.remove();
    } catch {
      try {
        await dlqJob.remove();
      } catch (rollbackErr) {
        this.logger.error(
          `moveToDeadLetter: job ${id} could not be removed from the default queue AND rollback of its dead-letter copy (jobId=${dlqJobId}) failed — manual reconciliation required. payload=${JSON.stringify(sanitizeSensitiveFields(dlqPayload))}: ${getErrorMessage(rollbackErr)}`
        );
      }
      throw new ConflictException(
        `Job ${id} could not be moved to dead-letter — it may be locked by a worker. Please retry.`
      );
    }

    return { id, moved: true };
  }

  async removeJob(id: string): Promise<{ id: string; removed: boolean }> {
    const job = await this.findJobAnywhere(id);
    await job.remove();
    return { id, removed: true };
  }

  private async findJobAnywhere(id: string): Promise<Job> {
    const job =
      (await this.queue.getJob(id)) ?? (await this.dlqQueue.getJob(id));
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  private async toSummary(job: Job, state?: string): Promise<QueueJobSummary> {
    const resolvedState = state ?? (await job.getState());
    return {
      id: String(job.id),
      name: job.name,
      type: (job.data?.type as string | undefined) ?? job.data?.originalType,
      status: resolvedState,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    };
  }

  private buildJobId(data: {
    type: string;
    payload?: unknown;
  }): string | undefined {
    if (!this.isDeduplicatedJobType(data.type)) {
      return undefined;
    }

    const payload = this.asRecord(data.payload);
    const stableKey =
      this.readString(payload, "bookingCode") ??
      this.readString(payload, "email") ??
      this.readString(payload, "bookingId") ??
      randomUUID();

    return `${data.type}:${stableKey}`;
  }

  private isDeduplicatedJobType(type: string): boolean {
    return [
      "send-register-email",
      "send-password-reset",
      "send-booking-confirmation",
      "finalize-ticket-delivery",
      "refund-failure-alert",
    ].includes(type);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  }

  private readString(
    record: Record<string, unknown>,
    key: string
  ): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}
