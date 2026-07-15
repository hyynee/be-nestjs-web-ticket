import { UnauthorizedException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { getModelToken } from "@nestjs/mongoose";
import { JwtStrategy } from "./jwt.strategy";
import { User } from "@src/schemas/user.schema";
import { RedisService } from "@src/redis/redis.service";
import type { Request } from "express";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ACCESS_TOKEN = "tok.tok.tok";

const makeReq = (token?: string): Request =>
  ({
    cookies: token ? { access_token: token } : {},
  }) as unknown as Request;

const makePayload = (overrides = {}) => ({
  userId: "64c1f2e1e1e1e1e1e1e1e1e1",
  role: "user",
  ...overrides,
});

const makeUser = (overrides = {}) => ({
  _id: "64c1f2e1e1e1e1e1e1e1e1e1",
  role: "user",
  isActive: true,
  ...overrides,
});

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("JwtStrategy", () => {
  let strategy: JwtStrategy;
  let userModel: any;
  let redisClient: any;

  beforeEach(async () => {
    userModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(makeUser()),
        }),
      }),
    };

    redisClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JwtStrategy,
        {
          provide: ConfigService,
          useValue: {
            getOrThrow: jest
              .fn()
              .mockReturnValue("test-secret-key-32-chars-long!!!"),
          },
        },
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: RedisService, useValue: { client: redisClient } },
      ],
    }).compile();

    strategy = module.get<JwtStrategy>(JwtStrategy);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Invalid payload ───────────────────────────────────────────────────────

  it("throws UnauthorizedException for null payload", async () => {
    await expect(strategy.validate(makeReq(), null as any)).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("throws UnauthorizedException when payload has no userId", async () => {
    await expect(
      strategy.validate(makeReq(), { role: "user" } as any)
    ).rejects.toThrow(UnauthorizedException);
  });

  // ── Blacklisted token ─────────────────────────────────────────────────────

  it("throws UnauthorizedException when access token is blacklisted", async () => {
    redisClient.get.mockImplementation((key: string) => {
      if (key === `blacklist:access:${ACCESS_TOKEN}`)
        return Promise.resolve("1");
      return Promise.resolve(null);
    });

    await expect(
      strategy.validate(makeReq(ACCESS_TOKEN), makePayload())
    ).rejects.toThrow(UnauthorizedException);
  });

  // ── Redis cache hit ───────────────────────────────────────────────────────

  it("returns payload without DB lookup when user state is cached", async () => {
    redisClient.get.mockImplementation((key: string) => {
      if (key.startsWith("auth:user-state:")) {
        return Promise.resolve(
          JSON.stringify({ isActive: true, role: "user" })
        );
      }
      return Promise.resolve(null);
    });

    const payload = makePayload();
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(userModel.findById).not.toHaveBeenCalled();
    expect(result).toEqual(payload);
  });

  it("returns the fresh role from cached user state, overriding a stale JWT role", async () => {
    redisClient.get.mockImplementation((key: string) => {
      if (key.startsWith("auth:user-state:")) {
        return Promise.resolve(
          JSON.stringify({ isActive: true, role: "organizer" })
        );
      }
      return Promise.resolve(null);
    });

    const payload = makePayload({ role: "user" });
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(result).toEqual({ ...payload, role: "organizer" });
  });

  it("attaches isVerified:true from cached user state to the returned user", async () => {
    redisClient.get.mockImplementation((key: string) => {
      if (key.startsWith("auth:user-state:")) {
        return Promise.resolve(
          JSON.stringify({ isActive: true, role: "user", isVerified: true })
        );
      }
      return Promise.resolve(null);
    });

    const payload = makePayload();
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(result).toEqual({ ...payload, isVerified: true });
  });

  it("attaches isVerified:false from cached user state to the returned user", async () => {
    redisClient.get.mockImplementation((key: string) => {
      if (key.startsWith("auth:user-state:")) {
        return Promise.resolve(
          JSON.stringify({ isActive: true, role: "user", isVerified: false })
        );
      }
      return Promise.resolve(null);
    });

    const payload = makePayload();
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(result).toEqual({ ...payload, isVerified: false });
  });

  it("attaches isVerified from a fresh DB lookup on cache miss", async () => {
    userModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(makeUser({ isVerified: true })),
      }),
    });

    const payload = makePayload();
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(result).toEqual({ ...payload, isVerified: true });
    expect(redisClient.set).toHaveBeenCalledWith(
      `auth:user-state:${payload.userId}`,
      expect.stringContaining('"isVerified":true'),
      expect.objectContaining({ EX: expect.any(Number) })
    );
  });

  it("returns the fresh role from DB, overriding a stale JWT role", async () => {
    userModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(makeUser({ role: "checkin_staff" })),
      }),
    });

    const payload = makePayload({ role: "user" });
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(result).toEqual({ ...payload, role: "checkin_staff" });
  });

  it("throws when cached user state is inactive", async () => {
    redisClient.get.mockImplementation((key: string) => {
      if (key.startsWith("auth:user-state:")) {
        return Promise.resolve(
          JSON.stringify({ isActive: false, role: "user" })
        );
      }
      return Promise.resolve(null);
    });

    await expect(
      strategy.validate(makeReq(ACCESS_TOKEN), makePayload())
    ).rejects.toThrow(UnauthorizedException);
  });

  // ── Redis cache miss → DB fallback ────────────────────────────────────────

  it("fetches user from DB on cache miss and caches the result", async () => {
    const payload = makePayload();
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(userModel.findById).toHaveBeenCalledWith(payload.userId);
    expect(redisClient.set).toHaveBeenCalledWith(
      `auth:user-state:${payload.userId}`,
      expect.any(String),
      expect.objectContaining({ EX: expect.any(Number) })
    );
    expect(result).toEqual(payload);
  });

  it("throws UnauthorizedException when user not found in DB", async () => {
    userModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      }),
    });

    await expect(
      strategy.validate(makeReq(ACCESS_TOKEN), makePayload())
    ).rejects.toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when user is inactive in DB", async () => {
    userModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(makeUser({ isActive: false })),
      }),
    });

    await expect(
      strategy.validate(makeReq(ACCESS_TOKEN), makePayload())
    ).rejects.toThrow(UnauthorizedException);
  });

  // ── Redis unavailable — graceful fallback ────────────────────────────────

  it("uses DB when user cache Redis GET fails (blacklist check passes)", async () => {
    redisClient.get
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error("Redis connection lost"));

    const payload = makePayload();
    const result = await strategy.validate(makeReq(ACCESS_TOKEN), payload);

    expect(userModel.findById).toHaveBeenCalled();
    expect(result).toEqual(payload);
  });

  it("throws when blacklist Redis GET fails", async () => {
    redisClient.get.mockRejectedValue(new Error("Redis connection lost"));

    await expect(
      strategy.validate(makeReq(ACCESS_TOKEN), makePayload())
    ).rejects.toThrow(UnauthorizedException);
  });

  it("returns payload even when Redis SET fails after DB lookup", async () => {
    redisClient.set.mockRejectedValue(new Error("Redis write failure"));

    const payload = makePayload();
    await expect(
      strategy.validate(makeReq(ACCESS_TOKEN), payload)
    ).resolves.toEqual(payload);
  });

  // ── No access token cookie ─────────────────────────────────────────────────

  it("skips blacklist check when no access token in cookie", async () => {
    await strategy.validate(makeReq(), makePayload());
    const calls = (redisClient.get as jest.Mock).mock.calls.map(
      (c: any) => c[0] as string
    );
    expect(calls.some((k) => k.startsWith("blacklist:"))).toBe(false);
  });

  it("handles undefined cookies gracefully (no crash)", async () => {
    const req = {} as Request;
    const payload = makePayload();
    const result = await strategy.validate(req, payload);
    expect(result).toEqual(payload);
  });
});
