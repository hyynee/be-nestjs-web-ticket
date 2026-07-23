import { Test, TestingModule } from "@nestjs/testing";
import { getConnectionToken } from "@nestjs/mongoose";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { HealthService } from "./health.service";
import { RedisService } from "@src/redis/redis.service";
import { RedisSecurityService } from "@src/redis/redis-security.service";

describe("HealthService", () => {
  let service: HealthService;
  let mongoConnection: any;
  let redisService: any;
  let redisSecurityService: any;
  let queue: any;
  let configService: jest.Mocked<ConfigService>;

  const REQUIRED_CONFIG: Record<string, string> = {
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
    PAYPAL_CLIENT_ID: "paypal_id",
    PAYPAL_CLIENT_SECRET: "paypal_secret",
    SMTP_HOST: "smtp.example.com",
    SMTP_USER: "user@example.com",
  };

  beforeEach(async () => {
    mongoConnection = {
      readyState: 1,
      db: { command: jest.fn().mockResolvedValue({ ok: 1 }) },
    };

    redisService = {
      client: { ping: jest.fn().mockResolvedValue("PONG") },
    };

    redisSecurityService = {
      client: { ping: jest.fn().mockResolvedValue("PONG") },
    };

    queue = {
      client: Promise.resolve({
        info: jest.fn().mockResolvedValue("redis_version:7"),
      }),
    };

    configService = {
      get: jest.fn((key: string) => REQUIRED_CONFIG[key]),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        HealthService,
        { provide: getConnectionToken(), useValue: mongoConnection },
        { provide: RedisService, useValue: redisService },
        { provide: RedisSecurityService, useValue: redisSecurityService },
        { provide: getQueueToken("default"), useValue: queue },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get(HealthService);
  });

  afterEach(() => jest.clearAllMocks());

  it("is defined", () => expect(service).toBeDefined());

  it("returns ready when all dependencies are healthy", async () => {
    const result = await service.checkReadiness();
    expect(result).toEqual({
      status: "ready",
      checks: {
        mongodb: "ok",
        redisCache: "ok",
        redisSecurity: "ok",
        queue: "ok",
        config: "ok",
      },
    });
  });

  it("marks mongodb as failed when readyState is not connected", async () => {
    mongoConnection.readyState = 0;
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.mongodb).toBe("failed");
  });

  it("marks mongodb as failed when the ping command rejects", async () => {
    mongoConnection.db.command.mockRejectedValue(new Error("timeout"));
    const result = await service.checkReadiness();
    expect(result.checks.mongodb).toBe("failed");
  });

  it("marks redisCache as failed when ping rejects", async () => {
    redisService.client.ping.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.redisCache).toBe("failed");
  });

  it("marks redisSecurity as failed when ping rejects — an outage on the JWT blacklist instance MUST take readiness down, since every authenticated request depends on it", async () => {
    redisSecurityService.client.ping.mockRejectedValue(
      new Error("ECONNREFUSED")
    );
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.redisSecurity).toBe("failed");
  });

  it("does not mark redisCache as failed just because redisSecurity failed, and vice versa — they are independent checks", async () => {
    redisSecurityService.client.ping.mockRejectedValue(new Error("down"));
    const result = await service.checkReadiness();
    expect(result.checks.redisCache).toBe("ok");
    expect(result.checks.redisSecurity).toBe("failed");
  });

  it("marks queue as failed when the BullMQ client is unreachable", async () => {
    queue.client = Promise.reject(new Error("connection closed"));
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.queue).toBe("failed");
  });

  it("marks config as failed when a required key is missing", async () => {
    configService.get.mockImplementation((key: string) =>
      key === "STRIPE_SECRET_KEY" ? undefined : REQUIRED_CONFIG[key]
    );
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.config).toBe("failed");
  });

  it("never includes raw config values in the result", async () => {
    const result = await service.checkReadiness();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("sk_test");
    expect(serialized).not.toContain("whsec_test");
    expect(serialized).not.toContain("paypal_secret");
  });

  it("reports overall unavailable when only one dependency fails", async () => {
    queue.client = Promise.reject(new Error("down"));
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.mongodb).toBe("ok");
    expect(result.checks.redisCache).toBe("ok");
    expect(result.checks.redisSecurity).toBe("ok");
    expect(result.checks.config).toBe("ok");
  });
});
