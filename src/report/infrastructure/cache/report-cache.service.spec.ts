import { Types } from "mongoose";
import { RedisService } from "@src/redis/redis.service";
import { resolveReportDateRange } from "@src/report/domain/report-range.util";
import { ReportCacheService } from "./report-cache.service";

function makeRedisClientMock() {
  const store = new Map<string, string>();
  let generation = 0;

  return {
    store,
    get: jest.fn(async (key: string) => {
      if (key.endsWith(":gen"))
        return generation === 0 ? null : String(generation);
      return store.get(key) ?? null;
    }),
    set: jest.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    incr: jest.fn(async () => {
      generation += 1;
      return generation;
    }),
  };
}

describe("ReportCacheService", () => {
  let redisClient: ReturnType<typeof makeRedisClientMock>;
  let cache: ReportCacheService;
  const range = resolveReportDateRange("2026-03-01", "2026-03-31");

  beforeEach(() => {
    redisClient = makeRedisClientMock();
    const redisService = { client: redisClient } as unknown as RedisService;
    cache = new ReportCacheService(redisService);
  });

  it("computes and stores on cache miss, then returns the cached value on a subsequent call within TTL", async () => {
    const compute = jest.fn().mockResolvedValue({ grossRevenue: 1000 });

    const first = await cache.salesReport({}, range, "day", 1, 20, compute);
    const second = await cache.salesReport({}, range, "day", 1, 20, compute);

    expect(first).toEqual({ grossRevenue: 1000 });
    expect(second).toEqual({ grossRevenue: 1000 });
    expect(compute).toHaveBeenCalledTimes(1); // second call served from cache
  });

  it("builds distinct cache entries for different scopes (event vs unrestricted)", async () => {
    const computeAll = jest.fn().mockResolvedValue({ grossRevenue: 1 });
    const computeEvent = jest.fn().mockResolvedValue({ grossRevenue: 2 });
    const eventId = new Types.ObjectId();

    await cache.salesReport({}, range, "day", 1, 20, computeAll);
    await cache.salesReport(
      { eventIdEq: eventId },
      range,
      "day",
      1,
      20,
      computeEvent
    );

    expect(computeAll).toHaveBeenCalledTimes(1);
    expect(computeEvent).toHaveBeenCalledTimes(1);
    expect(redisClient.store.size).toBe(2);
  });

  it("re-computes after invalidateAll bumps the generation counter", async () => {
    const compute = jest
      .fn()
      .mockResolvedValueOnce({ grossRevenue: 1000 })
      .mockResolvedValueOnce({ grossRevenue: 2000 });

    const before = await cache.salesReport({}, range, "day", 1, 20, compute);
    await cache.invalidateAll();
    const after = await cache.salesReport({}, range, "day", 1, 20, compute);

    expect(before).toEqual({ grossRevenue: 1000 });
    expect(after).toEqual({ grossRevenue: 2000 });
    expect(compute).toHaveBeenCalledTimes(2);
    expect(redisClient.incr).toHaveBeenCalledTimes(1);
  });

  it("falls back to compute() and never throws when Redis read fails", async () => {
    redisClient.get.mockRejectedValueOnce(new Error("redis down"));
    const compute = jest.fn().mockResolvedValue({ grossRevenue: 42 });

    const result = await cache.salesReport({}, range, "day", 1, 20, compute);

    expect(result).toEqual({ grossRevenue: 42 });
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("still returns compute() result when Redis write fails", async () => {
    redisClient.set.mockRejectedValueOnce(new Error("redis down"));
    const compute = jest.fn().mockResolvedValue({ grossRevenue: 7 });

    const result = await cache.salesReport({}, range, "day", 1, 20, compute);

    expect(result).toEqual({ grossRevenue: 7 });
  });

  it("invalidateAll never throws even when Redis INCR fails", async () => {
    redisClient.incr.mockRejectedValueOnce(new Error("redis down"));

    await expect(cache.invalidateAll()).resolves.toBeUndefined();
  });
});
