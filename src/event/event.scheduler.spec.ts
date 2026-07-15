import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { EventScheduler } from "./event.scheduler";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { RedisService } from "@src/redis/redis.service";

describe("EventScheduler", () => {
  let scheduler: EventScheduler;
  let eventModel: { updateMany: jest.Mock };
  let redisClient: {
    set: jest.Mock;
    eval: jest.Mock;
  };

  beforeEach(async () => {
    eventModel = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
    };

    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      eval: jest.fn().mockResolvedValue(1),
    };

    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventScheduler,
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: RedisService, useValue: { client: redisClient } },
      ],
    }).compile();

    scheduler = module.get(EventScheduler);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("handleAutoEndEvents", () => {
    it("acquires the Redis lock and auto-ends active/inactive events past their endDate", async () => {
      eventModel.updateMany.mockResolvedValue({ modifiedCount: 3 });

      await scheduler.handleAutoEndEvents();

      expect(redisClient.set).toHaveBeenCalledWith(
        "cron:lock:end-events",
        expect.any(String),
        expect.objectContaining({ NX: true })
      );
      expect(eventModel.updateMany).toHaveBeenCalledWith(
        {
          status: { $in: [EventStatus.ACTIVE, EventStatus.INACTIVE] },
          isDeleted: false,
          endDate: { $lte: expect.any(Date) },
        },
        { $set: { status: EventStatus.ENDED } }
      );
    });

    it("releases the lock in the finally block after success", async () => {
      await scheduler.handleAutoEndEvents();
      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keys: ["cron:lock:end-events"] })
      );
    });

    it("skips the run when another instance holds the lock", async () => {
      redisClient.set.mockResolvedValueOnce(null);

      await scheduler.handleAutoEndEvents();

      expect(eventModel.updateMany).not.toHaveBeenCalled();
    });

    it("releases the lock even when updateMany throws", async () => {
      eventModel.updateMany.mockRejectedValueOnce(new Error("Mongo down"));

      await scheduler.handleAutoEndEvents();

      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keys: ["cron:lock:end-events"] })
      );
    });

    it("does not throw when the lock release itself fails", async () => {
      redisClient.eval.mockRejectedValueOnce(new Error("Redis blip"));

      await expect(scheduler.handleAutoEndEvents()).resolves.toBeUndefined();
    });
  });
});
