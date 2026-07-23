import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { RedisSecurityService } from "./redis-security.service";
import { Logger } from "@nestjs/common";

// ── Mock the redis module ─────────────────────────────────────────────────────

const mockRedisClient = {
  connect: jest.fn().mockResolvedValue(undefined),
  quit: jest.fn().mockResolvedValue(undefined),
  on: jest.fn(),
  isOpen: true,
};

let capturedCreateClientOptions: any = null;

jest.mock("redis", () => ({
  createClient: jest.fn((opts: any) => {
    capturedCreateClientOptions = opts;
    return mockRedisClient;
  }),
}));

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("RedisSecurityService", () => {
  let service: RedisSecurityService;

  const defaultConfig = {
    getOrThrow: jest.fn().mockImplementation((key: string) => {
      if (key === "REDIS_HOST") return "redis-cache-fallback";
      if (key === "REDIS_PORT") return "6379";
      if (key === "REDIS_QUEUE_PORT") return "6380";
      if (key === "REDIS_SECURITY_PORT") return "6390";
      throw new Error(`Unknown key: ${key}`);
    }),
    get: jest.fn().mockImplementation((key: string) => {
      if (key === "REDIS_QUEUE_HOST") return "redis-queue";
      if (key === "REDIS_QUEUE_PORT") return "6380";
      if (key === "REDIS_QUEUE_PASSWORD") return "queue-secret";
      if (key === "REDIS_PASSWORD") return undefined;
      if (key === "REDIS_SECURITY_DB") return undefined;
      if (key === "NODE_ENV") return "test";
      return undefined;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    capturedCreateClientOptions = null;
  });

  const buildService = async (config: Record<string, any>) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedisSecurityService,
        { provide: ConfigService, useValue: config },
      ],
    }).compile();

    service = module.get<RedisSecurityService>(RedisSecurityService);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    return service;
  };

  describe("REDIS_SECURITY_* takes priority over queue/cache", () => {
    it("uses REDIS_SECURITY_HOST/PORT/PASSWORD/DB when explicitly set, ignoring queue and cache entirely", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST") return "redis-security";
          if (key === "REDIS_SECURITY_PORT") return "6390";
          if (key === "REDIS_SECURITY_PASSWORD") return "security-secret";
          if (key === "REDIS_SECURITY_DB") return "2";
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PASSWORD") return "queue-secret";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await buildService(config);
      expect(capturedCreateClientOptions.socket.host).toBe("redis-security");
      expect(capturedCreateClientOptions.socket.port).toBe(6390);
      expect(capturedCreateClientOptions.password).toBe("security-secret");
      expect(capturedCreateClientOptions.database).toBe(2);
    });

    it("enables TLS on the socket when REDIS_SECURITY_TLS=true (managed/hosted provider, e.g. Upstash)", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST")
            return "tender-dinosaur.upstash.io";
          if (key === "REDIS_SECURITY_PORT") return "6379";
          if (key === "REDIS_SECURITY_PASSWORD") return "upstash-secret";
          if (key === "REDIS_SECURITY_TLS") return "true";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await buildService(config);
      expect(capturedCreateClientOptions.socket.tls).toBe(true);
    });

    it("does NOT enable TLS on the socket when REDIS_SECURITY_TLS is unset (self-hosted plain-TCP, e.g. docker-compose)", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST") return "redis-security";
          if (key === "REDIS_SECURITY_PORT") return "6390";
          if (key === "REDIS_SECURITY_PASSWORD") return "security-secret";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await buildService(config);
      expect(capturedCreateClientOptions.socket.tls).toBeUndefined();
    });

    it("throws when REDIS_SECURITY_PORT is NaN", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST") return "redis-security";
          if (key === "REDIS_SECURITY_PORT") return "not-a-number";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "[RedisSecurity] REDIS_SECURITY_PORT must be a valid number"
      );
    });
  });

  describe("dev/test fallback (non-production only)", () => {
    it("connects to the redis-queue (noeviction) instance, not redis-cache, when REDIS_SECURITY_HOST is not set", async () => {
      await buildService(defaultConfig);
      expect(capturedCreateClientOptions.socket.host).toBe("redis-queue");
      expect(capturedCreateClientOptions.socket.port).toBe(6380);
      expect(capturedCreateClientOptions.password).toBe("queue-secret");
    });

    it("logs a clear warning identifying the queue fallback", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      await buildService(defaultConfig);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to REDIS_QUEUE_HOST")
      );
    });

    it("defaults database to 1 (isolated from BullMQ's DB 0) when REDIS_SECURITY_DB is not set", async () => {
      await buildService(defaultConfig);
      expect(capturedCreateClientOptions.database).toBe(1);
    });

    it("uses REDIS_SECURITY_DB when explicitly set", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PORT") return "6380";
          if (key === "REDIS_QUEUE_PASSWORD") return "queue-secret";
          if (key === "REDIS_SECURITY_DB") return "3";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await buildService(config);
      expect(capturedCreateClientOptions.database).toBe(3);
    });

    it("falls back to REDIS_HOST/REDIS_PORT when neither REDIS_SECURITY_HOST nor REDIS_QUEUE_HOST is configured (dev/local)", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_PASSWORD") return "cache-secret";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await buildService(config);
      expect(capturedCreateClientOptions.socket.host).toBe(
        "redis-cache-fallback"
      );
      expect(capturedCreateClientOptions.socket.port).toBe(6379);
      expect(capturedCreateClientOptions.password).toBe("cache-secret");
    });

    it("logs a clear warning identifying the cache fallback", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_PASSWORD") return "cache-secret";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      await buildService(config);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("falling back to REDIS_HOST")
      );
    });

    it("throws when REDIS_QUEUE_PORT is NaN", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PORT") return "not-a-number";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "[RedisSecurity] REDIS_QUEUE_PORT must be a valid number"
      );
    });

    it("throws when REDIS_SECURITY_DB is NaN", async () => {
      const config = {
        ...defaultConfig,
        get: jest.fn((key: string) => {
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PORT") return "6380";
          if (key === "REDIS_SECURITY_DB") return "not-a-number";
          if (key === "NODE_ENV") return "test";
          return undefined;
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "[RedisSecurity] REDIS_SECURITY_DB must be a valid number"
      );
    });
  });

  describe("production — dedicated security Redis is mandatory", () => {
    const prodConfigBase = {
      getOrThrow: jest.fn((key: string) => {
        if (key === "REDIS_HOST") return "redis-cache-fallback";
        if (key === "REDIS_PORT") return "6379";
        return "irrelevant";
      }),
      get: jest.fn((key: string) => {
        if (key === "REDIS_SECURITY_HOST") return "redis-security";
        if (key === "REDIS_SECURITY_PORT") return "6390";
        if (key === "REDIS_SECURITY_PASSWORD") return "security-secret";
        if (key === "REDIS_QUEUE_HOST") return "redis-queue";
        if (key === "REDIS_QUEUE_PORT") return "6380";
        if (key === "REDIS_QUEUE_PASSWORD") return "queue-secret";
        if (key === "NODE_ENV") return "production";
        return undefined;
      }),
    };

    it("connects successfully when REDIS_SECURITY_HOST/PORT are a genuinely separate endpoint", async () => {
      await buildService(prodConfigBase);
      expect(capturedCreateClientOptions.socket.host).toBe("redis-security");
      expect(capturedCreateClientOptions.socket.port).toBe(6390);
    });

    it("throws when REDIS_SECURITY_HOST is not set in production — must NOT fall back to queue or cache", async () => {
      const config = {
        ...prodConfigBase,
        get: jest.fn((key: string) => {
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PORT") return "6380";
          if (key === "NODE_ENV") return "production";
          return undefined;
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "[RedisSecurity] REDIS_SECURITY_HOST is required in production"
      );
    });

    it("throws (defense-in-depth) when REDIS_SECURITY_HOST/PORT resolve to the same endpoint as REDIS_HOST/PORT (cache)", async () => {
      const config = {
        ...prodConfigBase,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST") return "redis-cache-fallback";
          if (key === "REDIS_SECURITY_PORT") return "6379"; // same as cache port
          if (key === "NODE_ENV") return "production";
          return undefined;
        }),
        getOrThrow: jest.fn((key: string) => {
          if (key === "REDIS_HOST") return "redis-cache-fallback";
          if (key === "REDIS_PORT") return "6379";
          return "irrelevant";
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "must not be the same endpoint as REDIS_HOST/PORT"
      );
    });

    it("throws (defense-in-depth) when REDIS_SECURITY_HOST/PORT resolve to the same endpoint as REDIS_QUEUE_HOST/PORT", async () => {
      const config = {
        ...prodConfigBase,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST") return "redis-queue";
          if (key === "REDIS_SECURITY_PORT") return "6380"; // same as queue port
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PORT") return "6380";
          if (key === "NODE_ENV") return "production";
          return undefined;
        }),
        getOrThrow: jest.fn((key: string) => {
          if (key === "REDIS_HOST") return "redis-cache-fallback";
          if (key === "REDIS_PORT") return "6379";
          return "irrelevant";
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "must not be the same endpoint as the queue Redis"
      );
    });

    it("throws even when REDIS_SECURITY_DB differs from the queue's DB — host/port equality alone is disqualifying, since a shared physical instance is the actual SPOF", async () => {
      const config = {
        ...prodConfigBase,
        get: jest.fn((key: string) => {
          if (key === "REDIS_SECURITY_HOST") return "redis-queue";
          if (key === "REDIS_SECURITY_PORT") return "6380";
          if (key === "REDIS_SECURITY_DB") return "5"; // deliberately different DB index
          if (key === "REDIS_QUEUE_HOST") return "redis-queue";
          if (key === "REDIS_QUEUE_PORT") return "6380";
          if (key === "NODE_ENV") return "production";
          return undefined;
        }),
        getOrThrow: jest.fn((key: string) => {
          if (key === "REDIS_HOST") return "redis-cache-fallback";
          if (key === "REDIS_PORT") return "6379";
          return "irrelevant";
        }),
      };
      await expect(buildService(config)).rejects.toThrow(
        "must not be the same endpoint as the queue Redis"
      );
    });

    it("throws in production when connection fails", async () => {
      service = await buildService(prodConfigBase);
      mockRedisClient.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(service.onModuleInit()).rejects.toThrow(
        "[RedisSecurity] Startup aborted because the security Redis instance is unavailable in production"
      );
    });
  });

  describe("onModuleInit", () => {
    it("connects successfully", async () => {
      service = await buildService(defaultConfig);
      await service.onModuleInit();
      expect(mockRedisClient.connect).toHaveBeenCalledTimes(1);
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
});
