import { Test, TestingModule } from "@nestjs/testing";
import { getQueueToken } from "@nestjs/bullmq";
import { Job, Queue } from "bullmq";
import { Logger } from "@nestjs/common";
import { EventCancellationQueueProcessor } from "./event-cancellation-queue.processor";
import { CancelEventBookingsUseCase } from "@src/event/application/use-case/cancel-event-bookings.use-case";
import { FAILED_JOB_ALERT_THRESHOLD } from "./queue.service";

describe("EventCancellationQueueProcessor", () => {
  let processor: EventCancellationQueueProcessor;
  let cancelEventBookingsUseCase: jest.Mocked<CancelEventBookingsUseCase>;
  let queue: jest.Mocked<Queue>;
  let dlqQueue: jest.Mocked<Queue>;

  const mockJob = (data: any, opts?: any) =>
    ({
      data,
      opts: opts ?? { attempts: 3 },
      id: "evt-cancel-job-1",
      attemptsMade: 0,
    }) as unknown as Job;

  beforeEach(async () => {
    cancelEventBookingsUseCase = {
      execute: jest.fn().mockResolvedValue(undefined),
    } as any;

    queue = {
      getJobCounts: jest.fn(),
    } as any;

    dlqQueue = {
      add: jest.fn().mockResolvedValue(undefined),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventCancellationQueueProcessor,
        {
          provide: CancelEventBookingsUseCase,
          useValue: cancelEventBookingsUseCase,
        },
        { provide: getQueueToken("event-cancellation"), useValue: queue },
        { provide: getQueueToken("dead-letter"), useValue: dlqQueue },
      ],
    }).compile();

    processor = module.get<EventCancellationQueueProcessor>(
      EventCancellationQueueProcessor
    );
  });

  afterEach(() => jest.restoreAllMocks());

  describe("process", () => {
    it("delegates to CancelEventBookingsUseCase.execute with the cancellationJobId", async () => {
      const job = mockJob({
        type: "cancel-event-bookings",
        payload: { cancellationJobId: "cancellation-job-1" },
      });

      const result = await processor.process(job);

      expect(cancelEventBookingsUseCase.execute).toHaveBeenCalledWith(
        "cancellation-job-1"
      );
      expect(result).toBe(true);
    });

    it("throws on missing job data", async () => {
      const job = { data: null, id: "j1" } as unknown as Job;
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      await expect(processor.process(job)).rejects.toThrow("Invalid job data");
    });

    it("throws on missing type in job data", async () => {
      const job = mockJob({});
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      await expect(processor.process(job)).rejects.toThrow("Invalid job data");
    });

    it("throws for any job type other than cancel-event-bookings — this queue only ever handles one job type", async () => {
      const job = mockJob({ type: "send-register-email", payload: {} });
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      await expect(processor.process(job)).rejects.toThrow(
        "Unknown job type: send-register-email"
      );
      expect(cancelEventBookingsUseCase.execute).not.toHaveBeenCalled();
    });

    it("propagates and logs errors from CancelEventBookingsUseCase so BullMQ retries/dead-letters correctly", async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      cancelEventBookingsUseCase.execute.mockRejectedValue(
        new Error("Mongo unavailable")
      );
      const job = mockJob({
        type: "cancel-event-bookings",
        payload: { cancellationJobId: "cancellation-job-1" },
      });

      await expect(processor.process(job)).rejects.toThrow("Mongo unavailable");
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Job failed")
      );
    });
  });

  describe("onFailed", () => {
    const makeJob = (
      attemptsMade: number,
      maxAttempts: number = 3,
      data?: any
    ) =>
      ({
        id: "evt-cancel-fail-1",
        attemptsMade,
        opts: { attempts: maxAttempts },
        data: data ?? { type: "cancel-event-bookings" },
      }) as unknown as Job;

    const makeError = (msg: string) => new Error(msg);

    it("returns early when attemptsMade < maxAttempts (does not dead-letter yet)", async () => {
      jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      await processor.onFailed(makeJob(1, 3), makeError("fail"));
      expect(dlqQueue.add).not.toHaveBeenCalled();
    });

    it("moves an exhausted-retries job to the shared dead-letter queue", async () => {
      queue.getJobCounts.mockResolvedValueOnce({ failed: 5 } as any);
      jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("still failing"));

      expect(dlqQueue.add).toHaveBeenCalledWith(
        "dead-letter",
        expect.objectContaining({
          originalType: "cancel-event-bookings",
          error: "still failing",
        }),
        expect.any(Object)
      );
    });

    it("logs error when failedCount exceeds the shared alert threshold", async () => {
      queue.getJobCounts.mockResolvedValueOnce({
        failed: FAILED_JOB_ALERT_THRESHOLD + 1,
      } as any);
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("critical"));

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("exceeded threshold")
      );
    });

    it("logs a fallback warning when getJobCounts throws, without crashing", async () => {
      queue.getJobCounts.mockRejectedValueOnce(new Error("redis down"));
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});

      await processor.onFailed(makeJob(3, 3), makeError("error"));

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("failed count unavailable")
      );
    });
  });
});
