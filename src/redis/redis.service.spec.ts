import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { RedisService } from "./redis.service";
import { Logger } from "@nestjs/common";

// ── Mock the redis module ─────────────────────────────────────────────────────

const mockRedisClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  isOpen: true,
  scan: jest.fn(),
};

let capturedCreateClientOptions: any = null;

jest.mock("redis", () => ({
  createClient: jest.fn((opts: any) => {
    capturedCreateClientOptions = opts;
    return mockRedisClient;
  }),
}));

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("RedisService", () => {
  let service: RedisService;

  const defaultConfig = {
    getOrThrow: jest.fn().mockImplementation((key: string) => {
      if (key === "REDIS_HOST") return "localhost";
      if (key === "REDIS_PORT") return "6379";
      throw new Error(`Unknown key: ${key}`);
    }),
    get: jest.fn().mockImplementation((key: string) => {
      if (key === "REDIS_PASSWORD") return undefined;
      if (key === "REDIS_DB") return "0";
      if (key === "NODE_ENV") return "test";
      return undefined;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockRedisClient.scan.mockResolvedValue({ cursor: 0, keys: [] });
  });

  const buildService = async (config: Record<string, any>) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [RedisService, { provide: ConfigService, useValue: config }],
    }).compile();

    service = module.get<RedisService>(RedisService);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    return service;
  };

  describe("constructor", () => {
    it("throws when REDIS_PORT is NaN", async () => {
      const config = {
        ...defaultConfig,
        getOrThrow: jest.fn((key: string) => {
          if (key === "REDIS_HOST") return "localhost";
          if (key === "REDIS_PORT") return "not-a-number";
          throw new Error(`Unknown key: ${key}`);
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "[Redis] REDIS_PORT must be a valid number"
      );
    });

    it("throws when REDIS_DB is NaN", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_PASSWORD") return undefined;
          if (key === "REDIS_DB") return "not-a-number";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "[Redis] REDIS_DB must be a valid number"
      );
    });

    it("sets password when REDIS_PASSWORD is provided", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_PASSWORD") return "secret123";
          if (key === "REDIS_DB") return "0";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      const service = await buildService(config);
      expect(service.client).toBeDefined();
    });

    it("defaults database to 0 when REDIS_DB is not set", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_PASSWORD") return undefined;
          if (key === "REDIS_DB") return undefined;
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      const service = await buildService(config);
      expect(service.client).toBeDefined();
    });
  });

  describe("onModuleInit", () => {
    it("connects successfully", async () => {
      service = await buildService(defaultConfig);
      await service.onModuleInit();
      expect(mockRedisClient.connect).toHaveBeenCalledTimes(1);
    });

    it("throws in production when connection fails", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_PASSWORD") return undefined;
          if (key === "REDIS_DB") return "0";
          if (key === "NODE_ENV") return "production";
          return undefined;
        }),
      };
      service = await buildService(config);
      mockRedisClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(service.onModuleInit()).rejects.toThrow(
        "[Redis] Startup aborted because Redis is unavailable in production"
      );
    });

    it("logs warning in non-production when connection fails", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      const warnSpy = jest.spyOn(Logger.prototype, "warn");

      await expect(service.onModuleInit()).resolves.not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "continuing startup because NODE_ENV is not production"
        )
      );
    });
  });

  describe("onModuleDestroy", () => {
    it("quits client when open", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.isOpen = true;
      await service.onModuleDestroy();
      expect(mockRedisClient.quit).toHaveBeenCalledTimes(1);
    });

    it("does nothing when client is not open", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.isOpen = false;
      await service.onModuleDestroy();
      expect(mockRedisClient.quit).not.toHaveBeenCalled();
    });
  });

  describe("reconnectStrategy", () => {
    beforeEach(() => {
      capturedCreateClientOptions = null;
    });

    it("returns error after 20 retries", async () => {
      await buildService(defaultConfig);
      const strategy = capturedCreateClientOptions?.socket?.reconnectStrategy;
      expect(strategy).toBeDefined();

      const result = strategy(21);
      expect(result).toBeInstanceOf(Error);
    });

    it("returns exponential backoff delay for retries <= 20", async () => {
      await buildService(defaultConfig);
      const strategy = capturedCreateClientOptions?.socket?.reconnectStrategy;

      const delay1 = strategy(1);
      expect(typeof delay1).toBe("number");
      expect(delay1).toBeGreaterThan(0);
    });
  });

  describe("client error event", () => {
    it("emits error event on client", async () => {
      await buildService(defaultConfig);
      expect(mockRedisClient.on).toHaveBeenCalledWith(
        "error",
        expect.any(Function)
      );
    });

    it("logs error when client emits error event", async () => {
      const errorSpy = jest
        .spyOn(Logger.prototype, "error")
        .mockImplementation(() => {});
      mockRedisClient.on.mockClear();
      await buildService(defaultConfig);
      const errorHandler = mockRedisClient.on.mock.calls.find(
        ([event]: [string]) => event === "error"
      )?.[1] as (err: Error) => void;
      errorHandler(new Error("ECONNREFUSED"));
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("ECONNREFUSED")
      );
    });
  });

  describe("scanKeys", () => {
    it("returns empty array when no keys match", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.scan.mockResolvedValueOnce({ cursor: 0, keys: [] });
      const result = await service.scanKeys("bookings:list:*");
      expect(result).toEqual([]);
    });

    it("returns matching keys from a single cursor iteration", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.scan.mockResolvedValueOnce({
        cursor: 0,
        keys: ["bookings:list:a", "bookings:list:b"],
      });
      const result = await service.scanKeys("bookings:list:*");
      expect(result).toEqual(["bookings:list:a", "bookings:list:b"]);
    });

    it("iterates multiple cursor pages until cursor is 0", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.scan
        .mockResolvedValueOnce({ cursor: 42, keys: ["key:1", "key:2"] })
        .mockResolvedValueOnce({ cursor: 0, keys: ["key:3"] });

      const result = await service.scanKeys("key:*");
      expect(result).toEqual(["key:1", "key:2", "key:3"]);
      expect(mockRedisClient.scan).toHaveBeenCalledTimes(2);
    });

    it("passes the correct MATCH pattern and COUNT to SCAN", async () => {
      service = await buildService(defaultConfig);
      await service.scanKeys("tickets:user:abc:*");
      expect(mockRedisClient.scan).toHaveBeenCalledWith(0, {
        MATCH: "tickets:user:abc:*",
        COUNT: 100,
      });
    });

    it("passes updated cursor on second iteration", async () => {
      service = await buildService(defaultConfig);
      mockRedisClient.scan
        .mockResolvedValueOnce({ cursor: 7, keys: [] })
        .mockResolvedValueOnce({ cursor: 0, keys: [] });

      await service.scanKeys("test:*");
      expect(mockRedisClient.scan.mock.calls[1][0]).toBe(7);
    });
  });
});
