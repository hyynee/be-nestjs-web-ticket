import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { StatisticalScheduler } from "./statistical.scheduler";
import { StatisticalService } from "./statistical.service";
import { RedisService } from "@src/redis/redis.service";

describe("StatisticalScheduler", () => {
  let scheduler: StatisticalScheduler;
  let statisticalService: { warmGlobalCache: jest.Mock };
  let redisClient: { set: jest.Mock; eval: jest.Mock };

  beforeEach(async () => {
    statisticalService = {
      warmGlobalCache: jest.fn().mockResolvedValue(undefined),
    };

    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    };

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatisticalScheduler,
        { provide: StatisticalService, useValue: statisticalService },
        { provide: RedisService, useValue: { client: redisClient } },
      ],
    }).compile();

    scheduler = module.get<StatisticalScheduler>(StatisticalScheduler);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("warmDashboardCache", () => {
    const LOCK_KEY = "cron:lock:stat-warmup";

    it("acquires Redis lock and calls warmGlobalCache", async () => {
      await scheduler.warmDashboardCache();

      expect(redisClient.set).toHaveBeenCalledWith(
        LOCK_KEY,
        expect.any(String),
        expect.objectContaining({ NX: true, EX: 270 })
      );
      expect(statisticalService.warmGlobalCache).toHaveBeenCalledTimes(1);
    });

    it("releases the lock in the finally block after success", async () => {
      await scheduler.warmDashboardCache();

      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keys: [LOCK_KEY] })
      );
    });

    it("skips run when another instance holds the lock (null response)", async () => {
      redisClient.set.mockResolvedValueOnce(null);

      await scheduler.warmDashboardCache();

      expect(statisticalService.warmGlobalCache).not.toHaveBeenCalled();
    });

    it("releases lock even when warmGlobalCache throws", async () => {
      statisticalService.warmGlobalCache.mockRejectedValueOnce(
        new Error("DB error")
      );

      await scheduler.warmDashboardCache();

      expect(redisClient.eval).toHaveBeenCalled();
    });

    it("skips gracefully when Redis lock acquire fails (throw)", async () => {
      redisClient.set.mockRejectedValueOnce(
        new Error("Redis connection refused")
      );

      await expect(scheduler.warmDashboardCache()).resolves.toBeUndefined();

      expect(statisticalService.warmGlobalCache).not.toHaveBeenCalled();
    });

    it("logs error when lock acquire fails", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.set.mockRejectedValueOnce(new Error("Redis down"));

      await scheduler.warmDashboardCache();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("lock acquire failed")
      );
    });

    it("logs debug when lock is held by another instance", async () => {
      const debugSpy = jest.spyOn(Logger.prototype, "debug");
      redisClient.set.mockResolvedValueOnce(null);

      await scheduler.warmDashboardCache();

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining("lock held by another instance")
      );
    });

    it("logs completion on successful warmup", async () => {
      const logSpy = jest.spyOn(Logger.prototype, "log");

      await scheduler.warmDashboardCache();

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("completed"));
    });

    it("logs error when warmGlobalCache fails", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      statisticalService.warmGlobalCache.mockRejectedValueOnce(
        new Error("Aggregation timeout")
      );

      await scheduler.warmDashboardCache();

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("failed"));
    });

    it("releases lock even when warmGlobalCache succeeds", async () => {
      await scheduler.warmDashboardCache();

      expect(redisClient.eval).toHaveBeenCalled();
    });

    it("logs lock release failure without throwing", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.eval.mockRejectedValueOnce(new Error("EVAL script error"));

      await expect(scheduler.warmDashboardCache()).resolves.toBeUndefined();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("lock release failed")
      );
    });

    it("does not throw when warmGlobalCache fails and lock release fails", async () => {
      statisticalService.warmGlobalCache.mockRejectedValueOnce(
        new Error("Cache error")
      );
      redisClient.eval.mockRejectedValueOnce(new Error("Release error"));

      await expect(scheduler.warmDashboardCache()).resolves.toBeUndefined();
    });

    it("logs string rejection when lock acquire fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.set.mockRejectedValueOnce("string error");

      await scheduler.warmDashboardCache();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("string error")
      );
    });

    it("logs string rejection when warmGlobalCache fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      statisticalService.warmGlobalCache.mockRejectedValueOnce(
        "string rejection"
      );

      await scheduler.warmDashboardCache();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("string rejection")
      );
    });

    it("logs string rejection when lock release fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.eval.mockRejectedValueOnce("string eval error");

      await scheduler.warmDashboardCache();

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("string eval error")
      );
    });
  });
});
