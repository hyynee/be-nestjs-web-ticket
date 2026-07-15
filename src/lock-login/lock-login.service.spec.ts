import { Test, TestingModule } from "@nestjs/testing";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { LockLoginService } from "./lock-login.service";
import { RedisService } from "@src/redis/redis.service";

describe("LockLoginService", () => {
  let service: LockLoginService;

  const logger = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  };

  const redisClient = {
    get: jest.fn(),
    ttl: jest.fn(),
    del: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  };

  const redisService = {
    client: redisClient,
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LockLoginService,
        { provide: WINSTON_MODULE_PROVIDER, useValue: logger },
        { provide: RedisService, useValue: redisService },
      ],
    }).compile();

    service = module.get<LockLoginService>(LockLoginService);
  });

  it("returns true when global email failures reach threshold", async () => {
    redisClient.get.mockResolvedValue("10");

    const result = await service.isLocked("test@mail.com", "127.0.0.1");

    expect(result).toBe(true);
  });

  it("returns false when failed attempts below threshold", async () => {
    redisClient.get.mockResolvedValue("2");

    const result = await service.isLocked("test@mail.com", "127.0.0.1");

    expect(result).toBe(false);
    expect(redisClient.ttl).not.toHaveBeenCalled();
  });

  it("returns true when attempts reach threshold and ttl is valid", async () => {
    redisClient.get.mockResolvedValue("5");
    redisClient.ttl.mockResolvedValue(300);

    const result = await service.isLocked("test@mail.com", "127.0.0.1");

    expect(result).toBe(true);
  });

  it("returns false and clears key when ttl <= 0", async () => {
    redisClient.get.mockResolvedValue("5");
    redisClient.ttl.mockResolvedValue(0);
    redisClient.del.mockResolvedValue(1);

    const result = await service.isLocked("test@mail.com", "127.0.0.1");

    expect(result).toBe(false);
    expect(redisClient.del).toHaveBeenCalledTimes(1);
  });

  it("records first failed attempt with ttl and warning log", async () => {
    redisClient.incr.mockResolvedValue(1);
    redisClient.ttl.mockResolvedValue(900);

    await service.recordFailedAttempt("test@mail.com", "127.0.0.1");

    expect(redisClient.expire).toHaveBeenCalledWith(
      expect.stringContaining("auth:fail:"),
      900,
      "NX"
    );
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("re-applies ttl when ttl is negative", async () => {
    redisClient.incr.mockResolvedValue(2);
    redisClient.ttl.mockResolvedValueOnce(-1).mockResolvedValueOnce(900);

    await service.recordFailedAttempt("test@mail.com", "127.0.0.1");

    expect(redisClient.expire).toHaveBeenCalledWith(
      expect.stringContaining("auth:fail:"),
      900,
      "NX"
    );
  });

  it("logs error when attempts reach lock threshold", async () => {
    redisClient.incr.mockResolvedValue(5);
    redisClient.ttl.mockResolvedValue(800);

    await service.recordFailedAttempt("test@mail.com", "127.0.0.1");

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("resets key and logs info when key existed", async () => {
    redisClient.del.mockResolvedValue(1);

    await service.resetLocked("test@mail.com", "127.0.0.1");

    expect(redisClient.del).toHaveBeenCalledTimes(2); // per-IP key + global email key
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it("does not log info when no key deleted", async () => {
    redisClient.del.mockResolvedValue(0);

    await service.resetLocked("test@mail.com", "127.0.0.1");

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("buildLockKey handles empty identifier and ipAddress defaults", async () => {
    redisClient.get.mockResolvedValue(null);
    redisClient.incr.mockResolvedValue(1);
    redisClient.ttl.mockResolvedValue(900);

    await service.isLocked("", "");
    expect(redisClient.get).toHaveBeenCalledWith(
      expect.stringContaining("auth:fail:unknown:unknown")
    );

    // When identifier is blank, the key should contain 'unknown'
    jest.clearAllMocks();
    redisClient.get.mockResolvedValue(null);
    await service.isLocked("", "");
    expect(redisClient.get).toHaveBeenCalledWith(
      expect.stringContaining("unknown")
    );
  });

  it("isLocked returns false when key does not exist (null)", async () => {
    redisClient.get.mockResolvedValue(null);
    const result = await service.isLocked("user@test.com", "10.0.0.1");
    expect(result).toBe(false);
  });

  it("recordFailedAttempt handles negative ttl gracefully", async () => {
    redisClient.incr.mockResolvedValue(3);
    redisClient.ttl.mockResolvedValue(-2);

    await service.recordFailedAttempt("test@mail.com", "127.0.0.1");
    expect(redisClient.expire).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
