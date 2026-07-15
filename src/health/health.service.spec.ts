import { Test, TestingModule } from "@nestjs/testing";
import { getConnectionToken } from "@nestjs/mongoose";
import { getQueueToken } from "@nestjs/bullmq";
import { ConfigService } from "@nestjs/config";
import { HealthService } from "./health.service";
import { RedisService } from "@src/redis/redis.service";

describe("HealthService", () => {
  let service: HealthService;
  let mongoConnection: any;
  let redisService: any;
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
      checks: { mongo: "ok", redis: "ok", queue: "ok", config: "ok" },
    });
  });

  it("marks mongo as failed when readyState is not connected", async () => {
    mongoConnection.readyState = 0;
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.mongo).toBe("failed");
  });

  it("marks mongo as failed when the ping command rejects", async () => {
    mongoConnection.db.command.mockRejectedValue(new Error("timeout"));
    const result = await service.checkReadiness();
    expect(result.checks.mongo).toBe("failed");
  });

  it("marks redis as failed when ping rejects", async () => {
    redisService.client.ping.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await service.checkReadiness();
    expect(result.status).toBe("unavailable");
    expect(result.checks.redis).toBe("failed");
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
    expect(result.checks.mongo).toBe("ok");
    expect(result.checks.redis).toBe("ok");
    expect(result.checks.config).toBe("ok");
  });
});
