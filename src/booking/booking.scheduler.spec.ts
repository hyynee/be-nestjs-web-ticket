import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { BookingScheduler } from "./booking.scheduler";
import { BookingService } from "./booking.service";
import { RedisService } from "@src/redis/redis.service";

describe("BookingScheduler", () => {
  let scheduler: BookingScheduler;
  let bookingService: {
    expirePendingBookings: jest.Mock;
    cleanupOldBookings: jest.Mock;
  };
  let redisClient: {
    set: jest.Mock;
    eval: jest.Mock;
    get: jest.Mock;
  };

  beforeEach(async () => {
    bookingService = {
      expirePendingBookings: jest.fn().mockResolvedValue({ expired: 5 }),
      cleanupOldBookings: jest.fn().mockResolvedValue(undefined),
    };

    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
      get: jest.fn().mockResolvedValue(null),
    };

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingScheduler,
        { provide: BookingService, useValue: bookingService },
        { provide: RedisService, useValue: { client: redisClient } },
      ],
    }).compile();

    scheduler = module.get(BookingScheduler);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("handleExpireBookings", () => {
    it("acquires Redis lock and calls expirePendingBookings", async () => {
      await scheduler.handleExpireBookings();
      expect(redisClient.set).toHaveBeenCalledWith(
        "cron:lock:expire-bookings",
        expect.any(String),
        expect.objectContaining({ NX: true })
      );
      expect(bookingService.expirePendingBookings).toHaveBeenCalledTimes(1);
    });

    it("releases the lock in the finally block after success", async () => {
      await scheduler.handleExpireBookings();
      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keys: ["cron:lock:expire-bookings"] })
      );
    });

    it("skips run when another instance holds the lock", async () => {
      redisClient.set.mockResolvedValueOnce(null); // lock not acquired
      await scheduler.handleExpireBookings();
      expect(bookingService.expirePendingBookings).not.toHaveBeenCalled();
    });

    it("releases lock even when expirePendingBookings throws", async () => {
      bookingService.expirePendingBookings.mockRejectedValueOnce(
        new Error("DB error")
      );
      await scheduler.handleExpireBookings();
      expect(redisClient.eval).toHaveBeenCalled();
    });

    it("skips gracefully when Redis lock acquire fails", async () => {
      redisClient.set.mockRejectedValueOnce(new Error("Redis down"));
      // Should not throw — logs error and skips
      await expect(scheduler.handleExpireBookings()).resolves.toBeUndefined();
      expect(bookingService.expirePendingBookings).not.toHaveBeenCalled();
    });

    it("logs unknown error type when Redis lock acquire fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.set.mockRejectedValueOnce("string error");
      await scheduler.handleExpireBookings();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    });

    it("continues loop while batch is full and stops when result is null", async () => {
      bookingService.expirePendingBookings
        .mockResolvedValueOnce({ expired: 500 })
        .mockResolvedValueOnce(null);
      await scheduler.handleExpireBookings();
      expect(bookingService.expirePendingBookings).toHaveBeenCalledTimes(2);
    });

    it("logs unknown error type when expirePendingBookings throws non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      bookingService.expirePendingBookings.mockRejectedValueOnce(
        "string error"
      );
      await scheduler.handleExpireBookings();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("unknown error")
      );
    });

    it("logs unknown error type when lock release fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.eval.mockRejectedValueOnce("string error");
      bookingService.expirePendingBookings.mockResolvedValue({ expired: 0 });
      await scheduler.handleExpireBookings();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    });
  });

  describe("handleCleanupOldBookings", () => {
    it("acquires cleanup lock and calls cleanupOldBookings with a 30-day cutoff", async () => {
      await scheduler.handleCleanupOldBookings();
      expect(redisClient.set).toHaveBeenCalledWith(
        "cron:lock:cleanup-bookings",
        expect.any(String),
        expect.objectContaining({ NX: true })
      );
      const cutoffArg = bookingService.cleanupOldBookings.mock
        .calls[0]?.[0] as Date;
      expect(cutoffArg).toBeInstanceOf(Date);
      const ageMs = Date.now() - cutoffArg.getTime();
      expect(ageMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000 - 5000);
    });

    it("skips when another instance holds the cleanup lock", async () => {
      redisClient.set.mockResolvedValueOnce(null);
      await scheduler.handleCleanupOldBookings();
      expect(bookingService.cleanupOldBookings).not.toHaveBeenCalled();
    });

    it("releases lock after successful cleanup", async () => {
      await scheduler.handleCleanupOldBookings();
      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keys: ["cron:lock:cleanup-bookings"] })
      );
    });

    it("logs unknown error type when cleanup lock acquire fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.set.mockRejectedValueOnce("string error");
      await scheduler.handleCleanupOldBookings();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    });

    it("logs unknown error type when cleanupOldBookings throws non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      bookingService.cleanupOldBookings.mockRejectedValueOnce("string error");
      await scheduler.handleCleanupOldBookings();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("unknown error")
      );
    });

    it("logs unknown error type when cleanup lock release fails with non-Error", async () => {
      const errorSpy = jest.spyOn(Logger.prototype, "error");
      redisClient.eval.mockRejectedValueOnce("string error");
      await scheduler.handleCleanupOldBookings();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
    });
  });
});
