import { Test, TestingModule } from "@nestjs/testing";
import { CurrencyService } from "./currency.service";
import { RedisService } from "@src/redis/redis.service";
import axios from "axios";

jest.mock("axios");

const makeRedis = (cachedValue: string | null = null) => ({
  client: {
    get: jest.fn().mockResolvedValue(cachedValue),
    set: jest.fn().mockResolvedValue("OK"),
  },
});

describe("CurrencyService", () => {
  let service: CurrencyService;
  let redisMock: ReturnType<typeof makeRedis>;

  const buildModule = async (redis = makeRedis()) => {
    redisMock = redis;
    const module: TestingModule = await Test.createTestingModule({
      providers: [CurrencyService, { provide: RedisService, useValue: redis }],
    }).compile();
    service = module.get(CurrencyService);
    return service;
  };

  afterEach(() => jest.clearAllMocks());

  describe("getVndPerUsd — Redis cache hit", () => {
    it("returns cached rate without calling the live API", async () => {
      await buildModule(makeRedis("25500"));
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(25500);
      expect(axios.get).not.toHaveBeenCalled();
    });

    it("ignores a cached rate that is outside valid bounds", async () => {
      await buildModule(makeRedis("999")); // below MIN
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 26000 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26000);
    });
  });

  describe("getVndPerUsd — live API fetch", () => {
    it("returns the live rate and writes it to Redis", async () => {
      await buildModule(makeRedis(null));
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 26500 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26500);
      expect(redisMock.client.set).toHaveBeenCalledWith(
        "currency:vnd_per_usd",
        "26500",
        expect.any(Object)
      );
    });

    it("falls back to env default when API returns out-of-range value", async () => {
      process.env.VND_TO_USD_RATE = "25000";
      await buildModule(makeRedis(null));
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 999_999 } }, // above MAX
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(25000);
      delete process.env.VND_TO_USD_RATE;
    });

    it("falls back to env default when API throws a network error", async () => {
      process.env.VND_TO_USD_RATE = "24500";
      await buildModule(makeRedis(null));
      (axios.get as jest.Mock).mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(24500);
      delete process.env.VND_TO_USD_RATE;
    });

    it("falls back to env default when API response has no VND field", async () => {
      process.env.VND_TO_USD_RATE = "26000";
      await buildModule(makeRedis(null));
      (axios.get as jest.Mock).mockResolvedValueOnce({ data: { rates: {} } });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26000);
      delete process.env.VND_TO_USD_RATE;
    });
  });

  describe("getVndPerUsd — Redis unavailable", () => {
    it("proceeds to API fetch when Redis throws", async () => {
      const failingRedis = {
        client: {
          get: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
          set: jest.fn().mockResolvedValue("OK"),
        },
      };
      await buildModule(failingRedis as any);
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 26200 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26200);
    });

    it("returns valid rate even when Redis set fails after API fetch", async () => {
      const failingSetRedis = {
        client: {
          get: jest.fn().mockResolvedValue(null),
          set: jest.fn().mockRejectedValue(new Error("SET failed")),
        },
      };
      await buildModule(failingSetRedis as any);
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 26800 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26800);
    });
  });

  describe("bounds validation", () => {
    it("accepts MIN boundary (18000)", async () => {
      await buildModule(makeRedis("18000"));
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(18000);
    });

    it("accepts MAX boundary (35000)", async () => {
      await buildModule(makeRedis("35000"));
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(35000);
    });

    it("rejects value just below MIN (17999)", async () => {
      await buildModule(makeRedis("17999"));
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 26000 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26000);
    });

    it("caches API result to Redis even when previous cache was invalid", async () => {
      await buildModule(makeRedis("999"));
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 27000 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(27000);
      expect(redisMock.client.set).toHaveBeenCalledWith(
        "currency:vnd_per_usd",
        "27000",
        expect.any(Object)
      );
    });

    it("handles NaN in cached value gracefully", async () => {
      await buildModule(makeRedis("not-a-number"));
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: { rates: { VND: 26000 } },
      });
      const rate = await service.getVndPerUsd();
      expect(rate).toBe(26000);
    });
  });
});
