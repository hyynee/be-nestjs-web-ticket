import { Test, TestingModule } from "@nestjs/testing";
import { AuthService } from "../auth.service";
import { JwtService } from "@nestjs/jwt";
import { getModelToken } from "@nestjs/mongoose";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { ACCESS_TOKEN_TTL_SECONDS } from "../auth.constants";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { UserEventsService } from "@src/events/user-event.services";
import { MailService } from "@src/services/mail.service";
import { RedisService } from "@src/redis/redis.service";
import { RedisSecurityService } from "@src/redis/redis-security.service";
import { TwoFactorService } from "@src/two-factor/two-factor.service";
import { AuthAccountService } from "../application/auth-account.service";
import { AuthLoginService } from "../application/auth-login.service";
import { AuthPasswordService } from "../application/auth-password.service";
import { AuthSessionService } from "../application/auth-session.service";
import { AuthUserQueryService } from "../application/auth-user-query.service";
import { AuthUserCacheService } from "../infrastructure/cache/auth-user-cache.service";
import { AuthCookieService } from "../infrastructure/http/auth-cookie.service";
import { AuthTokenService } from "../infrastructure/security/auth-token.service";
import { AuthPresenter } from "../presenters/auth.presenter";

const mockRedisClient: {
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
} = {
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn(),
  del: jest.fn(),
};

const mockRedisSecurityClient: {
  set: jest.Mock;
  get: jest.Mock;
} = {
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn(),
};

const mockSessionModel: {
  findOneAndUpdate: jest.Mock;
} = {
  findOneAndUpdate: jest.fn().mockResolvedValue(null),
};

const mockRes: any = {
  clearCookie: jest.fn(),
  cookie: jest.fn(),
};

const mockReq: any = (accessToken?: string, refreshToken?: string) => ({
  cookies: {
    ...(accessToken ? { access_token: accessToken } : {}),
    ...(refreshToken ? { refresh_token: refreshToken } : {}),
  },
});

describe("AuthService.logout — CRITICAL-9", () => {
  let service: AuthService;
  let jwtService: JwtService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSessionModel.findOneAndUpdate.mockResolvedValue(null);
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        AuthAccountService,
        AuthLoginService,
        AuthPasswordService,
        AuthSessionService,
        AuthUserQueryService,
        AuthUserCacheService,
        AuthCookieService,
        AuthTokenService,
        AuthPresenter,
        {
          provide: JwtService,
          useValue: { verify: jest.fn(), sign: jest.fn(), decode: jest.fn() },
        },
        { provide: getModelToken("User"), useValue: { findById: jest.fn() } },
        { provide: getModelToken("ResetToken"), useValue: {} },
        { provide: getModelToken("EmailVerificationToken"), useValue: {} },
        { provide: getModelToken("Session"), useValue: mockSessionModel },
        {
          provide: WINSTON_MODULE_PROVIDER,
          useValue: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
        },
        { provide: CACHE_MANAGER, useValue: { del: jest.fn() } },
        { provide: UserEventsService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: LockLoginService, useValue: {} },
        { provide: RedisService, useValue: { client: mockRedisClient } },
        {
          provide: RedisSecurityService,
          useValue: { client: mockRedisSecurityClient },
        },
        { provide: TwoFactorService, useValue: { verifyLoginOtp: jest.fn() } },
      ],
    }).compile();

    service = module.get(AuthService);
    jwtService = module.get(JwtService);
  });

  describe("access token blacklisting", () => {
    it("blacklists valid token with TTL = remaining lifetime", async () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 1800; // 30 min remaining

      (jwtService.verify as jest.Mock).mockReturnValue({ userId: "u1", exp });
      mockRedisClient.get.mockResolvedValue(null); // no refresh token

      await service.logout(undefined, mockRes, mockReq("valid.jwt.token"));

      expect(jwtService.verify).toHaveBeenCalledWith("valid.jwt.token");
      expect(mockRedisSecurityClient.set).toHaveBeenCalledWith(
        "blacklist:access:valid.jwt.token",
        "1",
        { EX: 1800 }
      );
    });

    it("blacklists on the dedicated security Redis client, not the general cache client", async () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 1800;
      (jwtService.verify as jest.Mock).mockReturnValue({ userId: "u1", exp });

      await service.logout(undefined, mockRes, mockReq("valid.jwt.token"));

      const cacheClientBlacklistWrites = mockRedisClient.set.mock.calls.filter(
        (c: any[]) => c[0].startsWith("blacklist:access:")
      );
      expect(cacheClientBlacklistWrites).toHaveLength(0);
    });

    it("caps TTL at ACCESS_TOKEN_TTL_SECONDS regardless of token exp claim", async () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 86400 * 365;

      (jwtService.verify as jest.Mock).mockReturnValue({ userId: "u1", exp });
      mockRedisClient.get.mockResolvedValue(null);

      await service.logout(undefined, mockRes, mockReq("inflated.exp.token"));

      const setCall = mockRedisSecurityClient.set.mock.calls.find((c: any[]) =>
        c[0].startsWith("blacklist:access:")
      );
      expect(setCall).toBeDefined();
      expect(setCall![2].EX).toBeLessThanOrEqual(ACCESS_TOKEN_TTL_SECONDS);
    });

    it("does NOT write to Redis when verify throws (invalid signature)", async () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error("invalid signature");
      });
      mockRedisClient.get.mockResolvedValue(null);

      await service.logout(undefined, mockRes, mockReq("forged.jwt.token"));

      const blacklistSet = mockRedisSecurityClient.set.mock.calls.filter(
        (c: any[]) => c[0].startsWith("blacklist:access:")
      );
      expect(blacklistSet).toHaveLength(0);
    });

    it("does NOT write to Redis when token is already expired (verify throws)", async () => {
      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error("jwt expired");
      });
      mockRedisClient.get.mockResolvedValue(null);

      await service.logout(undefined, mockRes, mockReq("expired.jwt.token"));

      const blacklistSet = mockRedisSecurityClient.set.mock.calls.filter(
        (c: any[]) => c[0].startsWith("blacklist:access:")
      );
      expect(blacklistSet).toHaveLength(0);
    });

    it("does NOT write to Redis when ttl = 0 (token at exact expiry boundary)", async () => {
      const now = Math.floor(Date.now() / 1000);
      (jwtService.verify as jest.Mock).mockReturnValue({
        userId: "u1",
        exp: now,
      });

      mockRedisClient.get.mockResolvedValue(null);

      await service.logout(undefined, mockRes, mockReq("boundary.token"));

      const blacklistSet = mockRedisSecurityClient.set.mock.calls.filter(
        (c: any[]) => c[0].startsWith("blacklist:access:")
      );
      expect(blacklistSet).toHaveLength(0);
    });

    it("does NOT write to Redis when access token cookie is missing", async () => {
      mockRedisClient.get.mockResolvedValue(null);

      await service.logout(undefined, mockRes, { cookies: {} });

      expect(jwtService.verify).not.toHaveBeenCalled();
      const blacklistSet = mockRedisSecurityClient.set.mock.calls.filter(
        (c: any[]) => c[0].startsWith("blacklist:access:")
      );
      expect(blacklistSet).toHaveLength(0);
    });
  });

  describe("cookies always cleared", () => {
    it("clears cookies even when no access token present", async () => {
      mockRedisClient.get.mockResolvedValue(null);
      await service.logout(undefined, mockRes, mockReq());
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        "access_token",
        expect.any(Object)
      );
      expect(mockRes.clearCookie).toHaveBeenCalledWith(
        "refresh_token",
        expect.any(Object)
      );
    });
  });

  describe("refresh token handling", () => {
    const VALID_REFRESH_TOKEN = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const INVALID_REFRESH_TOKEN = "not-a-uuid-format";

    it("should revoke only the matched session and invalidate cache when the refresh token matches a live session", async () => {
      mockSessionModel.findOneAndUpdate.mockResolvedValue({
        _id: "session-1",
        userId: { toString: () => "user-1" },
      });
      mockRedisClient.del.mockResolvedValue(1);

      await service.logout(VALID_REFRESH_TOKEN, mockRes, mockReq());

      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshTokenHash: expect.any(String),
          revokedAt: null,
        }),
        { $set: { revokedAt: expect.any(Date) } }
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        "user:details:v1:user-1"
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        "auth:user-state:user-1"
      );
      expect(mockRes.clearCookie).toHaveBeenCalledTimes(2);
    });

    it("should skip cache invalidation when valid refresh token format matches no live session", async () => {
      mockSessionModel.findOneAndUpdate.mockResolvedValue(null);

      const result = await service.logout(
        VALID_REFRESH_TOKEN,
        mockRes,
        mockReq()
      );

      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalled();
      expect(result.message).toBe("Logged out successfully");
    });

    it("should skip revocation and return success when refresh token has invalid UUID format", async () => {
      const result = await service.logout(
        INVALID_REFRESH_TOKEN,
        mockRes,
        mockReq()
      );

      expect(mockSessionModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result.message).toBe("Logged out successfully");
    });

    it("should return success when refresh token is undefined", async () => {
      const result = await service.logout(undefined, mockRes, mockReq());

      expect(mockSessionModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result.message).toBe("Logged out successfully");
    });

    it("should return success when refresh token is an empty string", async () => {
      const result = await service.logout("", mockRes, mockReq());

      expect(mockSessionModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result.message).toBe("Logged out successfully");
    });
  });

  describe("Redis unavailable", () => {
    afterEach(() => {
      mockRedisSecurityClient.set.mockReset();
      mockRedisSecurityClient.set.mockResolvedValue("OK");
    });

    it("should throw ServiceUnavailableException when Redis.set fails", async () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 1800;
      (jwtService.verify as jest.Mock).mockReturnValue({ userId: "u1", exp });
      mockRedisSecurityClient.set.mockRejectedValue(
        new Error("Redis connection refused")
      );

      await expect(
        service.logout(undefined, mockRes, mockReq("valid.jwt.token"))
      ).rejects.toThrow("Logout failed");
    });
  });

  describe("edge cases", () => {
    it("should handle both access token blacklist and session revocation together", async () => {
      const now = Math.floor(Date.now() / 1000);
      const exp = now + 600;
      const VALID_REFRESH_TOKEN = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

      (jwtService.verify as jest.Mock).mockReturnValue({ userId: "u1", exp });
      mockSessionModel.findOneAndUpdate.mockResolvedValue({
        _id: "session-1",
        userId: { toString: () => "user-1" },
      });

      await service.logout(
        VALID_REFRESH_TOKEN,
        mockRes,
        mockReq("access.jwt", VALID_REFRESH_TOKEN)
      );

      expect(mockRedisSecurityClient.set).toHaveBeenCalledWith(
        "blacklist:access:access.jwt",
        "1",
        { EX: 600 }
      );
      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalled();
    });

    it("should handle jwt verify failure in catch block and still revoke the session", async () => {
      const VALID_REFRESH_TOKEN = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

      (jwtService.verify as jest.Mock).mockImplementation(() => {
        throw new Error("jwt malformed");
      });
      mockSessionModel.findOneAndUpdate.mockResolvedValue({
        _id: "session-1",
        userId: { toString: () => "user-1" },
      });

      const result = await service.logout(
        VALID_REFRESH_TOKEN,
        mockRes,
        mockReq("malformed.jwt", VALID_REFRESH_TOKEN)
      );

      expect(result.message).toBe("Logged out successfully");
      // Session revocation should still happen
      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalled();
    });
  });
});
