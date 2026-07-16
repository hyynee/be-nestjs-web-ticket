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
import { QueueJobPayload } from "./dto/job-payloads.dto";

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
  data: QueueJobData | DeadLetterJobData;
  stacktrace: string[] | undefined;
}

export interface QueueJobData {
  type: string;
  payload?: QueueJobPayload;
  requestedAt?: string;
}

interface DeadLetterJobData {
  originalJobId: string | undefined;
  originalName: string;
  originalType: string | undefined;
  payload: QueueJobData;
  error: string;
  attemptsMade: number;
  failedAt: string;
}

export interface QueueStatsResult {
  default: Awaited<ReturnType<Queue<QueueJobData>["getJobCounts"]>>;
  deadLetter: Awaited<ReturnType<Queue<DeadLetterJobData>["getJobCounts"]>>;
}

export interface QueueListResult {
  data: QueueJobSummary[];
  page: number;
  limit: number;
  total: number;
}

export interface QueueCommandResult {
  id: string;
  retried?: boolean;
  moved?: boolean;
  removed?: boolean;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue("default") private readonly queue: Queue<QueueJobData>,
    @InjectQueue("dead-letter")
    private readonly dlqQueue: Queue<DeadLetterJobData>
  ) {}

  async getJobCounts(): Promise<
    Awaited<ReturnType<Queue<QueueJobData>["getJobCounts"]>>
  > {
    return this.queue.getJobCounts("active", "waiting", "failed", "delayed");
  }

  async addJob(
    data: QueueJobData,
    options?: { jobId?: string }
  ): Promise<Job<QueueJobData>> {
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
  async addAdminJob(data: QueueJobData): Promise<Job<QueueJobData>> {
    return this.addJob(data);
  }

  private queueStatsResult(
    defaultCounts: QueueStatsResult["default"],
    deadLetterCounts: QueueStatsResult["deadLetter"]
  ): QueueStatsResult {
    return {
      default: defaultCounts,
      deadLetter: deadLetterCounts,
    };
  }

  private queueListResult(input: {
    data: QueueJobSummary[];
    page: number;
    limit: number;
    total: number;
  }): QueueListResult {
    return {
      data: input.data,
      page: input.page,
      limit: input.limit,
      total: input.total,
    };
  }

  private queueJobDetail(
    summary: QueueJobSummary,
    job: Job<QueueJobData | DeadLetterJobData>
  ): QueueJobDetail {
    return {
      ...summary,
      data: sanitizeSensitiveFields(job.data),
      stacktrace: job.stacktrace?.length ? job.stacktrace : undefined,
    };
  }

  private retriedJob(id: string): QueueCommandResult {
    return { id, retried: true };
  }

  private movedJob(id: string): QueueCommandResult {
    return { id, moved: true };
  }

  private removedJob(id: string): QueueCommandResult {
    return { id, removed: true };
  }

  async getQueueStats(): Promise<QueueStatsResult> {
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

    return this.queueStatsResult(defaultCounts, deadLetterCounts);
  }

  async listJobs(query: QueryJobDto): Promise<QueueListResult> {
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

    return this.queueListResult({ data, page, limit, total });
  }

  async getJob(id: string): Promise<QueueJobDetail> {
    const job = await this.findJobAnywhere(id);
    const state = await job.getState();
    const summary = await this.toSummary(job, state);

    return this.queueJobDetail(summary, job);
  }

  async retryJob(id: string): Promise<QueueCommandResult> {
    const job = await this.queue.getJob(id);

    if (job) {
      await this.retryExistingJob(job);
      return this.retriedJob(id);
    }

    const dlqJob = await this.dlqQueue.getJob(id);
    if (!dlqJob) {
      throw new NotFoundException(`Job ${id} not found`);
    }

    const originalJobData = dlqJob.data?.payload as QueueJobData | undefined;
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
      await this.retryExistingJob(originalJob);
    } else {
      await this.addJob(originalJobData, {
        jobId: `retry:${originalJobId ?? id}:${Date.now()}`,
      });
    }

    await dlqJob.remove();

    return this.retriedJob(id);
  }

  private async retryExistingJob(
    job: Job<QueueJobData | DeadLetterJobData>
  ): Promise<void> {
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
  ): Promise<QueueCommandResult> {
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

    const dlqPayload: DeadLetterJobData = {
      originalJobId: job.id,
      originalName: job.name,
      originalType: job.data?.type,
      payload: job.data,
      error: reason ?? "Manually moved to dead-letter by admin",
      attemptsMade: job.attemptsMade,
      failedAt: new Date().toISOString(),
    };
    const dlqJobId = `dead-letter:${job.id ?? `${job.data?.type}:${Date.now()}`}`;

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

    return this.movedJob(id);
  }

  async removeJob(id: string): Promise<QueueCommandResult> {
    const job = await this.findJobAnywhere(id);
    await job.remove();
    return this.removedJob(id);
  }

  private async findJobAnywhere(
    id: string
  ): Promise<Job<QueueJobData | DeadLetterJobData>> {
    const job =
      (await this.queue.getJob(id)) ?? (await this.dlqQueue.getJob(id));
    if (!job) {
      throw new NotFoundException(`Job ${id} not found`);
    }
    return job;
  }

  private async toSummary(
    job: Job<QueueJobData | DeadLetterJobData>,
    state?: string
  ): Promise<QueueJobSummary> {
    const resolvedState = state ?? (await job.getState());
    return {
      id: String(job.id),
      name: job.name,
      type: this.getJobType(job.data),
      status: resolvedState,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
      processedOn: job.processedOn,
      finishedOn: job.finishedOn,
      failedReason: job.failedReason,
    };
  }

  private buildJobId(data: QueueJobData): string | undefined {
    if (!this.isDeduplicatedJobType(data.type)) {
      return undefined;
    }

    const stableKey =
      this.readPayloadString(data.payload, "bookingCode") ??
      this.readPayloadString(data.payload, "email") ??
      this.readPayloadString(data.payload, "bookingId") ??
      randomUUID();

    return `${this.toBullJobIdPart(data.type)}-${this.toBullJobIdPart(stableKey)}`;
  }

  private toBullJobIdPart(value: string): string {
    return value.replace(/:/g, "-");
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

  private readPayloadString(
    payload: QueueJobPayload | undefined,
    key: "bookingCode" | "email" | "bookingId"
  ): string | undefined {
    if (!payload) {
      return undefined;
    }

    let value: string | undefined;
    if (key === "bookingCode" && "bookingCode" in payload) {
      value = payload.bookingCode;
    } else if (key === "email" && "email" in payload) {
      value = payload.email;
    } else if (key === "bookingId" && "bookingId" in payload) {
      value = payload.bookingId;
    }

    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private getJobType(
    data: QueueJobData | DeadLetterJobData
  ): string | undefined {
    return "type" in data ? data.type : data.originalType;
  }
}
