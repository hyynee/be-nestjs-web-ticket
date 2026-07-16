import { Test, TestingModule } from "@nestjs/testing";
import {
  QueueService,
  FAILED_JOB_ALERT_THRESHOLD,
  FAILED_JOB_RETAIN_COUNT,
} from "./queue.service";
import { getQueueToken } from "@nestjs/bullmq";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("QueueService", () => {
  let service: QueueService;
  let mockQueue: any;
  let mockDlqQueue: any;

  const makeJob = (overrides: Record<string, unknown> = {}) => ({
    id: "job-1",
    name: "default",
    data: { type: "send-register-email", payload: { to: "a@b.com" } },
    attemptsMade: 1,
    timestamp: 1000,
    processedOn: 1001,
    finishedOn: 1002,
    failedReason: undefined,
    stacktrace: [],
    getState: jest.fn().mockResolvedValue("failed"),
    retry: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(async () => {
    mockQueue = {
      add: jest.fn().mockResolvedValue({ id: "job-1" }),
      getJobCounts: jest.fn().mockResolvedValue({
        active: 1,
        waiting: 2,
        failed: 0,
        delayed: 0,
        completed: 0,
      }),
      getJobs: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(undefined),
    };

    mockDlqQueue = {
      add: jest.fn().mockResolvedValue({ id: "dlq-1" }),
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 0,
        failed: 3,
        completed: 0,
      }),
      getJobs: jest.fn().mockResolvedValue([]),
      getJob: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        QueueService,
        { provide: getQueueToken("default"), useValue: mockQueue },
        { provide: getQueueToken("dead-letter"), useValue: mockDlqQueue },
      ],
    }).compile();

    service = module.get<QueueService>(QueueService);
  });

  afterEach(() => jest.clearAllMocks());

  it("is defined", () => expect(service).toBeDefined());

  // ── getJobCounts ──────────────────────────────────────────────────────────

  it("returns job counts from BullMQ", async () => {
    const counts = await service.getJobCounts();
    expect(counts.active).toBe(1);
    expect(counts.waiting).toBe(2);
  });

  // ── addJob ────────────────────────────────────────────────────────────────

  it("enqueues job with correct type and payload", async () => {
    await service.addJob({
      type: "send-register-email",
      payload: { to: "test@example.com" },
    });

    expect(mockQueue.add).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({ type: "send-register-email" }),
      expect.any(Object)
    );
  });

  it("configures 3 retry attempts with exponential backoff", async () => {
    await service.addJob({ type: "test-job" });
    const opts = (mockQueue.add as jest.Mock).mock.calls[0][2];
    expect(opts.attempts).toBe(3);
    expect(opts.backoff.type).toBe("exponential");
  });

  it("sets removeOnFail count to FAILED_JOB_RETAIN_COUNT", async () => {
    await service.addJob({ type: "test-job" });
    const opts = (mockQueue.add as jest.Mock).mock.calls[0][2];
    expect(opts.removeOnFail.count).toBe(FAILED_JOB_RETAIN_COUNT);
  });

  it("enqueues refund-failure-alert with higher priority and more retries", async () => {
    await service.addJob({
      type: "refund-failure-alert",
      payload: { bookingId: "123" },
    });
    const opts = (mockQueue.add as jest.Mock).mock.calls[0][2];
    expect(opts.attempts).toBe(6);
    expect(opts.priority).toBe(1);
    expect(opts.backoff.delay).toBe(10_000);
  });

  it("sanitizes deduplicated job ids for BullMQ", async () => {
    await service.addJob({
      type: "send-booking-confirmation",
      payload: { bookingCode: "BK:2026:001" },
    });

    const opts = (mockQueue.add as jest.Mock).mock.calls[0][2];
    expect(opts.jobId).toBe("send-booking-confirmation-BK-2026-001");
  });

  // ── addAdminJob ───────────────────────────────────────────────────────────

  it("addAdminJob delegates to addJob and returns the created job", async () => {
    const job = await service.addAdminJob({
      type: "send-register-email",
      payload: { to: "x@y.com" },
    });
    expect(job).toEqual({ id: "job-1" });
    expect(mockQueue.add).toHaveBeenCalled();
  });

  // ── getQueueStats ─────────────────────────────────────────────────────────

  it("aggregates counts from both default and dead-letter queues", async () => {
    const stats = await service.getQueueStats();
    expect(stats.default.active).toBe(1);
    expect(stats.deadLetter.failed).toBe(3);
  });

  // ── listJobs ──────────────────────────────────────────────────────────────

  it("lists jobs from the default queue with pagination", async () => {
    mockQueue.getJobs.mockResolvedValue([makeJob()]);
    mockQueue.getJobCounts.mockResolvedValue({ failed: 1 });

    const result = await service.listJobs({
      status: "failed",
      page: 1,
      limit: 20,
    } as any);

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0].id).toBe("job-1");
    expect(mockQueue.getJobs).toHaveBeenCalledWith(["failed"], 0, 19, false);
  });

  it("lists jobs from the dead-letter queue when queue=dead-letter", async () => {
    mockDlqQueue.getJobs.mockResolvedValue([makeJob({ name: "dead-letter" })]);
    mockDlqQueue.getJobCounts.mockResolvedValue({ failed: 1 });

    await service.listJobs({ queue: "dead-letter", page: 1, limit: 20 } as any);

    expect(mockDlqQueue.getJobs).toHaveBeenCalled();
    expect(mockQueue.getJobs).not.toHaveBeenCalled();
  });

  it("sums counts across all statuses when no status filter given", async () => {
    mockQueue.getJobCounts.mockResolvedValue({
      active: 2,
      waiting: 3,
      failed: 1,
      delayed: 0,
      completed: 4,
    });

    const result = await service.listJobs({ page: 1, limit: 20 } as any);
    expect(result.total).toBe(10);
  });

  // ── getJob ────────────────────────────────────────────────────────────────

  it("returns sanitized job detail, redacting sensitive payload keys", async () => {
    mockQueue.getJob.mockResolvedValue(
      makeJob({
        data: {
          type: "send-password-reset",
          payload: { email: "a@b.com", resetToken: "super-secret-token" },
        },
      })
    );

    const detail = await service.getJob("job-1");
    const payload = (detail.data as any).payload;
    expect(payload.email).toBe("a@b.com");
    expect(payload.resetToken).toBe("***REDACTED***");
  });

  it("falls back to the dead-letter queue when job not found in default", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    mockDlqQueue.getJob.mockResolvedValue(makeJob({ id: "dlq-1" }));

    const detail = await service.getJob("dlq-1");
    expect(detail.id).toBe("dlq-1");
  });

  it("throws NotFoundException when job does not exist in either queue", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    mockDlqQueue.getJob.mockResolvedValue(undefined);

    await expect(service.getJob("missing")).rejects.toThrow(NotFoundException);
  });

  // ── retryJob ──────────────────────────────────────────────────────────────

  it("retries a failed job found in the default queue", async () => {
    const job = makeJob({ getState: jest.fn().mockResolvedValue("failed") });
    mockQueue.getJob.mockResolvedValue(job);

    const result = await service.retryJob("job-1");
    expect(job.retry).toHaveBeenCalledWith("failed");
    expect(result).toEqual({ id: "job-1", retried: true });
  });

  it("rejects retry when job is in a non-retryable state", async () => {
    const job = makeJob({ getState: jest.fn().mockResolvedValue("active") });
    mockQueue.getJob.mockResolvedValue(job);

    await expect(service.retryJob("job-1")).rejects.toThrow(
      BadRequestException
    );
    expect(job.retry).not.toHaveBeenCalled();
  });

  it("re-enqueues from dead-letter with the original unwrapped payload (not double-nested)", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    // Matches the real shape written by queue.processor.ts's onFailed handler
    // and QueueService.moveToDeadLetter: `payload` holds the *entire* original
    // job.data (`{ type, payload }`), not just the inner payload.
    const dlqJob = makeJob({
      id: "dlq-1",
      data: {
        originalJobId: "job-1",
        originalType: "export-tickets",
        payload: {
          type: "export-tickets",
          payload: { dto: { eventId: "evt-1" }, requestedByUserId: "admin-1" },
        },
      },
    });
    mockDlqQueue.getJob.mockResolvedValue(dlqJob);

    const result = await service.retryJob("dlq-1");

    expect(mockQueue.add).toHaveBeenCalledWith(
      "default",
      expect.objectContaining({
        type: "export-tickets",
        payload: { dto: { eventId: "evt-1" }, requestedByUserId: "admin-1" },
      }),
      expect.any(Object)
    );
    expect(dlqJob.remove).toHaveBeenCalled();
    expect(result).toEqual({ id: "dlq-1", retried: true });
  });

  it("retries the original job in place when it still exists in the default queue, instead of re-adding", async () => {
    // Simulates a deduped job type (e.g. send-password-reset) whose failed
    // original is still retained in the default queue when the admin retries
    // from its dead-letter copy — re-adding with the same dedupe key would
    // silently no-op, so the original must be retried directly instead.
    const originalJob = makeJob({
      id: "job-1",
      getState: jest.fn().mockResolvedValue("failed"),
    });
    const dlqJob = makeJob({
      id: "dlq-1",
      data: {
        originalJobId: "job-1",
        payload: {
          type: "send-password-reset",
          payload: { email: "a@b.com" },
        },
      },
    });

    mockQueue.getJob.mockImplementation((jobId: string) =>
      Promise.resolve(jobId === "job-1" ? originalJob : undefined)
    );
    mockDlqQueue.getJob.mockResolvedValue(dlqJob);

    const result = await service.retryJob("dlq-1");

    expect(originalJob.retry).toHaveBeenCalledWith("failed");
    expect(mockQueue.add).not.toHaveBeenCalled();
    expect(dlqJob.remove).toHaveBeenCalled();
    expect(result).toEqual({ id: "dlq-1", retried: true });
  });

  it("forces a unique jobId when re-enqueuing a dead-letter entry whose original job was evicted", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    const dlqJob = makeJob({
      id: "dlq-1",
      data: {
        originalJobId: "job-1",
        payload: {
          type: "send-password-reset",
          payload: { email: "a@b.com" },
        },
      },
    });
    mockDlqQueue.getJob.mockResolvedValue(dlqJob);

    await service.retryJob("dlq-1");

    const [, , opts] = mockQueue.add.mock.calls[0];
    expect(opts.jobId).toMatch(/^retry:job-1:\d+$/);
  });

  it("throws NotFoundException when retrying a job that exists nowhere", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    mockDlqQueue.getJob.mockResolvedValue(undefined);

    await expect(service.retryJob("ghost")).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException when dead-letter entry has no original job data", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    mockDlqQueue.getJob.mockResolvedValue(makeJob({ data: {} }));

    await expect(service.retryJob("dlq-1")).rejects.toThrow(
      BadRequestException
    );
  });

  // ── moveToDeadLetter ──────────────────────────────────────────────────────

  it("moves a job to the dead-letter queue and removes it from default", async () => {
    const job = makeJob();
    mockQueue.getJob.mockResolvedValue(job);

    const result = await service.moveToDeadLetter("job-1", "stuck job");
    expect(mockDlqQueue.add).toHaveBeenCalledWith(
      "dead-letter",
      expect.objectContaining({
        originalJobId: "job-1",
        error: "stuck job",
      }),
      expect.any(Object)
    );
    expect(job.remove).toHaveBeenCalled();
    expect(result).toEqual({ id: "job-1", moved: true });
  });

  it("adds the dead-letter copy before removing the job from the default queue, using a deterministic jobId", async () => {
    const callOrder: string[] = [];
    const job = makeJob({
      remove: jest.fn().mockImplementation(async () => {
        callOrder.push("remove");
      }),
    });
    mockQueue.getJob.mockResolvedValue(job);
    mockDlqQueue.add.mockImplementation(async () => {
      callOrder.push("dlq-add");
      return makeJob({ id: "dead-letter:job-1" });
    });

    await service.moveToDeadLetter("job-1");

    expect(callOrder).toEqual(["dlq-add", "remove"]);
    const [, , opts] = mockDlqQueue.add.mock.calls[0];
    expect(opts.jobId).toBe("dead-letter:job-1");
  });

  it("rejects moving an active (currently processing) job to dead-letter", async () => {
    const job = makeJob({ getState: jest.fn().mockResolvedValue("active") });
    mockQueue.getJob.mockResolvedValue(job);

    await expect(service.moveToDeadLetter("job-1")).rejects.toThrow(
      BadRequestException
    );
    expect(job.remove).not.toHaveBeenCalled();
    expect(mockDlqQueue.add).not.toHaveBeenCalled();
  });

  it("never removes the source job when the dead-letter write itself fails", async () => {
    const job = makeJob();
    mockQueue.getJob.mockResolvedValue(job);
    mockDlqQueue.add.mockRejectedValue(new Error("redis unavailable"));

    await expect(service.moveToDeadLetter("job-1")).rejects.toThrow(
      "redis unavailable"
    );
    expect(job.remove).not.toHaveBeenCalled();
  });

  it("rolls back the dead-letter copy and throws ConflictException when the source job cannot be removed", async () => {
    const job = makeJob({
      remove: jest
        .fn()
        .mockRejectedValue(new Error("locked by another worker")),
    });
    mockQueue.getJob.mockResolvedValue(job);
    const dlqJob = makeJob({ id: "dead-letter:job-1" });
    mockDlqQueue.add.mockResolvedValue(dlqJob);

    await expect(service.moveToDeadLetter("job-1")).rejects.toThrow(
      ConflictException
    );
    expect(dlqJob.remove).toHaveBeenCalled();
  });

  it("logs sanitized payload (no raw secrets) when rollback of the dead-letter copy also fails", async () => {
    const errorSpy = jest.spyOn((service as any).logger, "error");
    const job = makeJob({
      remove: jest.fn().mockRejectedValue(new Error("locked")),
      data: {
        type: "send-password-reset",
        payload: { email: "a@b.com", resetToken: "top-secret-token" },
      },
    });
    mockQueue.getJob.mockResolvedValue(job);
    const dlqJob = makeJob({
      id: "dead-letter:job-1",
      remove: jest.fn().mockRejectedValue(new Error("dlq remove failed")),
    });
    mockDlqQueue.add.mockResolvedValue(dlqJob);

    await expect(service.moveToDeadLetter("job-1")).rejects.toThrow(
      ConflictException
    );

    const loggedMessage = errorSpy.mock.calls[0][0] as string;
    expect(loggedMessage).not.toContain("top-secret-token");
    expect(loggedMessage).toContain("***REDACTED***");
  });

  it("throws NotFoundException when moving a non-existent job", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    await expect(service.moveToDeadLetter("ghost")).rejects.toThrow(
      NotFoundException
    );
  });

  // ── removeJob ─────────────────────────────────────────────────────────────

  it("removes a job found in the default queue", async () => {
    const job = makeJob();
    mockQueue.getJob.mockResolvedValue(job);

    const result = await service.removeJob("job-1");
    expect(job.remove).toHaveBeenCalled();
    expect(result).toEqual({ id: "job-1", removed: true });
  });

  it("throws NotFoundException when removing a job that does not exist", async () => {
    mockQueue.getJob.mockResolvedValue(undefined);
    mockDlqQueue.getJob.mockResolvedValue(undefined);
    await expect(service.removeJob("ghost")).rejects.toThrow(NotFoundException);
  });

  // ── Constants ─────────────────────────────────────────────────────────────

  it("FAILED_JOB_ALERT_THRESHOLD is a positive number", () => {
    expect(FAILED_JOB_ALERT_THRESHOLD).toBeGreaterThan(0);
  });

  it("FAILED_JOB_RETAIN_COUNT is greater than FAILED_JOB_ALERT_THRESHOLD", () => {
    expect(FAILED_JOB_RETAIN_COUNT).toBeGreaterThan(FAILED_JOB_ALERT_THRESHOLD);
  });
});
