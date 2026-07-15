import { AuthGuard } from "./auth.guard";
import { UnauthorizedException } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";

const makeMockContext = (
  cookies: Record<string, string> = {}
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ cookies }),
    }),
  }) as unknown as ExecutionContext;

const makeJwtService = (
  payload: Record<string, unknown> | null = { userId: "user-1", role: "user" }
) => ({
  verifyAsync: jest
    .fn()
    .mockImplementation(() =>
      payload ? Promise.resolve(payload) : Promise.reject(new Error("invalid"))
    ),
});

const makeRedisService = (isBlacklisted: string | null = null) => ({
  client: {
    get: jest.fn().mockResolvedValue(isBlacklisted),
  },
});

describe("AuthGuard", () => {
  it("throws UnauthorizedException when no access_token cookie", async () => {
    const guard = new AuthGuard(
      makeJwtService() as any,
      makeRedisService() as any
    );
    await expect(guard.canActivate(makeMockContext({}))).rejects.toThrow(
      UnauthorizedException
    );
  });

  it("throws UnauthorizedException when token is blacklisted", async () => {
    const guard = new AuthGuard(
      makeJwtService() as any,
      makeRedisService("1") as any
    );
    await expect(
      guard.canActivate(
        makeMockContext({ access_token: "blacklisted.jwt.token" })
      )
    ).rejects.toThrow(UnauthorizedException);
  });

  it("throws UnauthorizedException when token is invalid", async () => {
    const guard = new AuthGuard(
      makeJwtService(null) as any,
      makeRedisService() as any
    );
    await expect(
      guard.canActivate(makeMockContext({ access_token: "bad.jwt" }))
    ).rejects.toThrow(UnauthorizedException);
  });

  it("sets request.user and returns true for a valid non-blacklisted token", async () => {
    const guard = new AuthGuard(
      makeJwtService() as any,
      makeRedisService() as any
    );
    const req: any = { cookies: { access_token: "valid.jwt.token" } };
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
    } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);
    expect(result).toBe(true);
    expect(req.user).toBeDefined();
  });

  it("throws UnauthorizedException when request has no cookies at all", async () => {
    const guard = new AuthGuard(
      makeJwtService() as any,
      makeRedisService() as any
    );
    const ctx = {
      switchToHttp: () => ({ getRequest: () => ({}) }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("throws when Redis get throws (fail closed)", async () => {
    const redisService = {
      client: {
        get: jest.fn().mockRejectedValue(new Error("Redis connection refused")),
      },
    };
    const guard = new AuthGuard(makeJwtService() as any, redisService as any);
    await expect(
      guard.canActivate(makeMockContext({ access_token: "any.jwt" }))
    ).rejects.toThrow("Auth service temporarily unavailable");
  });

  it("throws when Redis get throws with non-Error value", async () => {
    const redisService = {
      client: {
        get: jest.fn().mockRejectedValue("string error"),
      },
    };
    const guard = new AuthGuard(makeJwtService() as any, redisService as any);
    await expect(
      guard.canActivate(makeMockContext({ access_token: "any.jwt" }))
    ).rejects.toThrow(UnauthorizedException);
  });
});
