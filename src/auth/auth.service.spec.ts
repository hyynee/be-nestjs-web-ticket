import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { UserEventsService } from "@src/events/user-event.services";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { RedisService } from "@src/redis/redis.service";
import { MailService } from "@src/services/mail.service";
import { TwoFactorService } from "@src/two-factor/two-factor.service";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { AuthService } from "./auth.service";
import { AuthAccountService } from "./application/auth-account.service";
import { AuthLoginService } from "./application/auth-login.service";
import { AuthPasswordService } from "./application/auth-password.service";
import { AuthSessionService } from "./application/auth-session.service";
import { AuthUserQueryService } from "./application/auth-user-query.service";
import { AuthUserCacheService } from "./infrastructure/cache/auth-user-cache.service";
import { AuthCookieService } from "./infrastructure/http/auth-cookie.service";
import { AuthTokenService } from "./infrastructure/security/auth-token.service";
import { AuthPresenter } from "./presenters/auth.presenter";

jest.mock("cloudinary", () => ({
  v2: {
    url: jest.fn().mockReturnValue("https://mocked-cloudinary-url.com/image"),
  },
}));

const createResponseMock = () => ({
  cookie: jest.fn().mockReturnThis(),
  clearCookie: jest.fn().mockReturnThis(),
  redirect: jest.fn(),
});

describe("AuthService", () => {
  let service: AuthService;
  let mockUserModel: any;
  let mockResetTokenModel: any;
  let mockEmailVerificationTokenModel: any;
  let mockSessionModel: any;
  let mockJwtService: any;
  let _mockCache: any;
  let mockLockLoginService: any;
  let mockMailService: any;
  let mockUserEventsService: any;
  let mockLogger: any;
  let mockRedisClient: any;
  let mockRedisService: any;
  let mockTwoFactorService: any;

  const VALID_USER_ID = "64c1f2e1e1e1e1e1e1e1e1e1";
  const VALID_SESSION_ID = "64c1f2e1e1e1e1e1e1e1e1e2";
  const VALID_EMAIL = "test@mail.com";
  const VALID_PASSWORD = "Secret123!";
  const IP = "127.0.0.1";
  const META = { ipAddress: IP, userAgent: "jest-test-agent" };

  // Valid UUID v4 tokens used in tests — must pass UUID_V4_REGEX to reach service logic
  const VALID_REFRESH_TOKEN = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
  const VALID_RESET_TOKEN = "d3dddd33-3d3d-4dd3-9d3d-d3d3d3d3d3d3";
  const EXPIRED_RESET_TOKEN = "b1aabb11-1b2b-4bb2-ab2b-b2b2b2b2b2b2";
  const USED_RESET_TOKEN = "c2cccc22-2c2c-4cc2-8c2c-c2c2c2c2c2c2";

  beforeEach(async () => {
    const mockSession = {
      withTransaction: jest
        .fn()
        .mockImplementation((fn: () => Promise<unknown>) => fn()),
      endSession: jest.fn(),
    };

    mockUserModel = Object.assign(jest.fn(), {
      findOne: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      findOneAndUpdate: jest.fn(),
      db: { startSession: jest.fn().mockResolvedValue(mockSession) },
    });

    mockResetTokenModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      deleteMany: jest.fn(),
      deleteOne: jest.fn(),
      create: jest.fn(),
      updateOne: jest.fn(),
      db: { startSession: jest.fn().mockResolvedValue(mockSession) },
    };

    mockEmailVerificationTokenModel = {
      findOne: jest.fn().mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      }),
      findOneAndUpdate: jest.fn(),
      deleteMany: jest.fn().mockResolvedValue({ acknowledged: true }),
      create: jest
        .fn()
        .mockResolvedValue([{ _id: "verif-token-1", userId: VALID_USER_ID }]),
      db: { startSession: jest.fn().mockResolvedValue(mockSession) },
    };

    mockSessionModel = {
      create: jest.fn().mockResolvedValue({ _id: VALID_SESSION_ID }),
      findOne: jest.fn().mockResolvedValue(null),
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ acknowledged: true }),
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      }),
    };

    mockJwtService = {
      sign: jest.fn().mockReturnValue("mocked_access_token"),
    };

    _mockCache = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    mockLockLoginService = {
      recordFailedAttempt: jest.fn().mockResolvedValue(null),
      resetLocked: jest.fn().mockResolvedValue(null),
    };

    mockMailService = {
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
    };

    mockUserEventsService = {
      emitUserCreated: jest.fn(),
      emitUserLogin: jest.fn(),
      emitUserRegistered: jest.fn(),
      emitPasswordResetRequested: jest.fn(),
      emitEmailVerificationRequested: jest.fn(),
    };

    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
    };

    mockRedisClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      getDel: jest.fn().mockResolvedValue(null),
    };

    mockRedisService = {
      client: mockRedisClient,
    };

    mockTwoFactorService = {
      verifyLoginOtp: jest.fn().mockResolvedValue(false),
    };

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
        { provide: getModelToken("User"), useValue: mockUserModel },
        { provide: getModelToken("ResetToken"), useValue: mockResetTokenModel },
        {
          provide: getModelToken("EmailVerificationToken"),
          useValue: mockEmailVerificationTokenModel,
        },
        { provide: getModelToken("Session"), useValue: mockSessionModel },
        { provide: JwtService, useValue: mockJwtService },
        { provide: LockLoginService, useValue: mockLockLoginService },
        { provide: MailService, useValue: mockMailService },
        { provide: UserEventsService, useValue: mockUserEventsService },
        { provide: WINSTON_MODULE_PROVIDER, useValue: mockLogger },
        { provide: RedisService, useValue: mockRedisService },
        { provide: TwoFactorService, useValue: mockTwoFactorService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  describe("register", () => {
    it("should throw ConflictException neu email da ton tai (E11000 from save)", async () => {
      const duplicateKeyError = Object.assign(
        new Error("E11000 duplicate key"),
        { code: 11000 }
      );
      const saveMock = jest.fn().mockRejectedValue(duplicateKeyError);
      mockUserModel.mockImplementation(() => ({ save: saveMock }));

      await expect(
        service.register({
          email: VALID_EMAIL,
          password: VALID_PASSWORD,
          confirmPassword: VALID_PASSWORD,
          fullName: "Test User",
        } as any)
      ).rejects.toThrow(ConflictException);
    });

    it("should throw BadRequestException neu password khong khop", async () => {
      await expect(
        service.register({
          email: VALID_EMAIL,
          password: VALID_PASSWORD,
          confirmPassword: "WrongPass!",
          fullName: "Test User",
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should create user va emit event", async () => {
      const saveMock = jest.fn().mockResolvedValue(undefined);
      const fakeUser = {
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        save: saveMock,
      };

      mockUserModel.mockImplementation(() => fakeUser);

      const result = await service.register({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
        fullName: "Test User",
      } as any);

      expect(mockUserModel).toHaveBeenCalledWith({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
        fullName: "Test User",
        role: "user",
      });
      expect(saveMock).toHaveBeenCalled();
      expect(mockUserEventsService.emitUserRegistered).toHaveBeenCalledWith(
        fakeUser
      );
      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_USER_ID,
          email: VALID_EMAIL,
          isActive: true,
          isVerified: false,
        })
      );
      expect(result).not.toHaveProperty("save");
      expect(result).not.toHaveProperty("password");
    });

    it("creates an email verification token and emits the verification event", async () => {
      const saveMock = jest.fn().mockResolvedValue(undefined);
      const fakeUser = {
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        fullName: "Test User",
        save: saveMock,
      };
      mockUserModel.mockImplementation(() => fakeUser);

      await service.register({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
        fullName: "Test User",
      } as any);

      expect(mockEmailVerificationTokenModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            userId: VALID_USER_ID,
            tokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        ],
        expect.objectContaining({ session: expect.anything() })
      );
      expect(
        mockUserEventsService.emitEmailVerificationRequested
      ).toHaveBeenCalledWith(VALID_EMAIL, expect.any(String), "Test User");

      // Raw token handed to the event must never equal the hash persisted to DB.
      const [[tokenDocs]] = mockEmailVerificationTokenModel.create.mock.calls;
      const persistedHash = tokenDocs[0].tokenHash;
      const [, rawTokenEmitted] =
        mockUserEventsService.emitEmailVerificationRequested.mock.calls[0];
      expect(persistedHash).not.toBe(rawTokenEmitted);
    });

    it("does not create user or token when passwords do not match", async () => {
      await expect(
        service.register({
          email: VALID_EMAIL,
          password: VALID_PASSWORD,
          confirmPassword: "WrongPass!",
          fullName: "Test User",
        } as any)
      ).rejects.toThrow(BadRequestException);

      expect(mockUserModel).not.toHaveBeenCalled();
      expect(mockEmailVerificationTokenModel.create).not.toHaveBeenCalled();
    });
  });

  describe("login", () => {
    it("should throw UnauthorizedException va record failed attempt neu user khong ton tai", async () => {
      mockUserModel.findOne.mockResolvedValue(null);
      const response = createResponseMock();

      await expect(
        service.login(
          { email: VALID_EMAIL, password: VALID_PASSWORD } as any,
          META,
          response as any
        )
      ).rejects.toThrow(UnauthorizedException);

      expect(mockLockLoginService.recordFailedAttempt).toHaveBeenCalledWith(
        VALID_EMAIL,
        IP
      );
    });

    it("should throw UnauthorizedException va record failed attempt neu password sai", async () => {
      const fakeUser = {
        _id: VALID_USER_ID,
        comparePassword: jest.fn().mockResolvedValue(false),
      };
      mockUserModel.findOne.mockResolvedValue(fakeUser);
      const response = createResponseMock();

      await expect(
        service.login(
          { email: VALID_EMAIL, password: "wrong" } as any,
          META,
          response as any
        )
      ).rejects.toThrow(UnauthorizedException);

      expect(mockLockLoginService.recordFailedAttempt).toHaveBeenCalledWith(
        VALID_EMAIL,
        IP
      );
    });

    it("should login thanh cong, reset lock va set token cookies", async () => {
      const fakeUser = {
        _id: VALID_USER_ID,
        role: "user",
        comparePassword: jest.fn().mockResolvedValue(true),
      };
      const response = createResponseMock();

      mockUserModel.findOne.mockResolvedValue(fakeUser);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });

      const result = await service.login(
        { email: VALID_EMAIL, password: VALID_PASSWORD } as any,
        META,
        response as any
      );

      expect(mockLockLoginService.resetLocked).toHaveBeenCalledWith(
        VALID_EMAIL,
        IP
      );
      expect(response.cookie).toHaveBeenCalledTimes(2);
      expect(result.message).toBe("Logged in successfully");
    });

    it("returns requires2fa and does NOT set cookies when the user has 2FA enabled", async () => {
      const fakeUser = {
        _id: { toString: () => VALID_USER_ID },
        role: "admin",
        twoFactorEnabled: true,
        comparePassword: jest.fn().mockResolvedValue(true),
      };
      const response = createResponseMock();
      mockUserModel.findOne.mockResolvedValue(fakeUser);

      const result = await service.login(
        { email: VALID_EMAIL, password: VALID_PASSWORD } as any,
        META,
        response as any
      );

      expect(result).toEqual({
        status: "requires2fa",
        twoFactorToken: expect.any(String),
      });
      expect(response.cookie).not.toHaveBeenCalled();
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        expect.stringContaining("auth:2fa-pending:"),
        VALID_USER_ID,
        { EX: expect.any(Number) }
      );
    });
  });

  describe("completeTwoFactorLogin", () => {
    const PENDING_TOKEN = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

    it("throws UnauthorizedException when the token is not a valid UUID", async () => {
      const response = createResponseMock();

      await expect(
        service.completeTwoFactorLogin(
          "not-a-uuid",
          "123456",
          META,
          response as any
        )
      ).rejects.toThrow(UnauthorizedException);
      expect(mockRedisClient.getDel).not.toHaveBeenCalled();
    });

    it("throws UnauthorizedException when the pending token is missing/expired", async () => {
      mockRedisClient.getDel.mockResolvedValue(null);
      const response = createResponseMock();

      await expect(
        service.completeTwoFactorLogin(
          PENDING_TOKEN,
          "123456",
          META,
          response as any
        )
      ).rejects.toThrow(UnauthorizedException);
    });

    it("atomically consumes the pending token via GETDEL before verifying OTP (so a wrong OTP also burns it — no replay/race window)", async () => {
      mockRedisClient.getDel.mockResolvedValue(VALID_USER_ID);
      mockTwoFactorService.verifyLoginOtp.mockResolvedValue(false);
      const response = createResponseMock();

      await expect(
        service.completeTwoFactorLogin(
          PENDING_TOKEN,
          "000000",
          META,
          response as any
        )
      ).rejects.toThrow(UnauthorizedException);
      expect(mockRedisClient.getDel).toHaveBeenCalledWith(
        expect.stringContaining("auth:2fa-pending:")
      );
    });

    it("creates a session and sets cookies on valid OTP", async () => {
      mockRedisClient.getDel.mockResolvedValue(VALID_USER_ID);
      mockTwoFactorService.verifyLoginOtp.mockResolvedValue(true);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "admin",
        isActive: true,
      });
      const response = createResponseMock();

      const result = await service.completeTwoFactorLogin(
        PENDING_TOKEN,
        "123456",
        META,
        response as any
      );

      expect(mockTwoFactorService.verifyLoginOtp).toHaveBeenCalledWith(
        VALID_USER_ID,
        "123456"
      );
      expect(response.cookie).toHaveBeenCalledTimes(2);
      expect(result.message).toBe("Logged in successfully");
    });
  });

  describe("generateUserTokens", () => {
    it("should throw UnauthorizedException neu userId khong ton tai", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      await expect(service.generateUserTokens(VALID_USER_ID)).rejects.toThrow(
        UnauthorizedException
      );
    });

    it("should return accessToken va refreshToken hop le", async () => {
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });

      const result = await service.generateUserTokens(VALID_USER_ID, META);

      expect(mockJwtService.sign).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: VALID_USER_ID,
          role: "user",
          jti: expect.any(String),
        }),
        { expiresIn: 3600 }
      );
      expect(typeof result.accessToken).toBe("string");
      expect(typeof result.refreshToken).toBe("string");
      expect(mockSessionModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshTokenHash: expect.any(String),
          ipAddress: META.ipAddress,
          userAgent: META.userAgent,
          expiresAt: expect.any(Date),
        })
      );
    });

    it("creates a new session without touching any other session the user has", async () => {
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "admin",
        isActive: true,
      });

      await service.generateUserTokens(VALID_USER_ID, META);

      expect(mockSessionModel.create).toHaveBeenCalledTimes(1);
      expect(mockSessionModel.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("refreshToken", () => {
    it("should throw BadRequestException neu refreshToken rong", async () => {
      const response = createResponseMock();

      await expect(
        service.refreshToken("", META, response as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw UnauthorizedException va khong touch DB neu format sai", async () => {
      const response = createResponseMock();

      await expect(
        service.refreshToken("invalid_token", META, response as any)
      ).rejects.toThrow(UnauthorizedException);
      expect(mockSessionModel.findOne).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException neu khong tim thay session hop le", async () => {
      mockSessionModel.findOne.mockResolvedValue(null);
      const response = createResponseMock();

      await expect(
        service.refreshToken(VALID_REFRESH_TOKEN, META, response as any)
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should rotate refresh token, set cookies va tra ve message", async () => {
      const fakeSession = {
        _id: VALID_SESSION_ID,
        userId: VALID_USER_ID,
      };
      mockSessionModel.findOne.mockResolvedValue(fakeSession);
      mockSessionModel.findOneAndUpdate.mockResolvedValue(fakeSession);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });
      const response = createResponseMock();

      const result = await service.refreshToken(
        VALID_REFRESH_TOKEN,
        META,
        response as any
      );

      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: VALID_SESSION_ID,
          refreshTokenHash: expect.any(String),
          revokedAt: null,
          expiresAt: { $gt: expect.any(Date) },
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            refreshTokenHash: expect.any(String),
            ipAddress: META.ipAddress,
            userAgent: META.userAgent,
          }),
        })
      );
      expect(response.cookie).toHaveBeenCalledTimes(2);
      expect(result.message).toBe("Token refreshed successfully");
    });

    it("should throw UnauthorizedException khi thua concurrent rotation race", async () => {
      const fakeSession = { _id: VALID_SESSION_ID, userId: VALID_USER_ID };
      mockSessionModel.findOne.mockResolvedValue(fakeSession);
      mockSessionModel.findOneAndUpdate.mockResolvedValue(null);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });
      const response = createResponseMock();

      await expect(
        service.refreshToken(VALID_REFRESH_TOKEN, META, response as any)
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("logout", () => {
    it("should clear cookies va tra ve message thanh cong khi khong co refresh token", async () => {
      const response = createResponseMock();
      const request = { cookies: {} };

      const result = await service.logout(
        undefined,
        response as any,
        request as any
      );

      expect(response.clearCookie).toHaveBeenCalledTimes(2);
      expect(mockSessionModel.findOneAndUpdate).not.toHaveBeenCalled();
      expect(result.message).toBe("Logged out successfully");
    });

    it("should revoke only the current session, xoa cache, clear cookies va tra ve message thanh cong", async () => {
      mockSessionModel.findOneAndUpdate.mockResolvedValue({
        _id: VALID_SESSION_ID,
        userId: { toString: () => VALID_USER_ID },
      });
      const response = createResponseMock();
      const request = { cookies: {} };

      const result = await service.logout(
        VALID_REFRESH_TOKEN,
        response as any,
        request as any
      );

      expect(response.clearCookie).toHaveBeenCalledTimes(2);
      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          refreshTokenHash: expect.any(String),
          revokedAt: null,
        }),
        { $set: { revokedAt: expect.any(Date) } }
      );
      expect(mockSessionModel.updateMany).not.toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`
      );
      expect(result.message).toBe("Logged out successfully");
    });
  });

  describe("logoutAll", () => {
    it("should revoke all sessions, xoa cache, clear cookies va blacklist access token", async () => {
      const response = createResponseMock();
      const request = { cookies: {} };

      const result = await service.logoutAll(
        VALID_USER_ID,
        response as any,
        request as any
      );

      expect(response.clearCookie).toHaveBeenCalledTimes(2);
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.anything(),
          revokedAt: null,
        }),
        { $set: { revokedAt: expect.any(Date) } }
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`
      );
      expect(result.message).toBe("Logged out from all devices successfully");
    });
  });

  describe("getSessions", () => {
    it("returns active sessions sorted by lastUsedAt, without exposing the token hash", async () => {
      const sessionDocs = [
        {
          _id: VALID_SESSION_ID,
          refreshTokenHash: "hash-1",
          deviceInfo: "Chrome on Windows 10/11",
          ipAddress: IP,
          lastUsedAt: new Date("2026-07-14T00:00:00.000Z"),
          createdAt: new Date("2026-07-13T00:00:00.000Z"),
          expiresAt: new Date("2026-07-17T00:00:00.000Z"),
        },
      ];
      mockSessionModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(sessionDocs),
        }),
      });

      const result = await service.getSessions(VALID_USER_ID);

      expect(result).toEqual([
        {
          id: VALID_SESSION_ID,
          deviceInfo: "Chrome on Windows 10/11",
          ipAddress: IP,
          lastUsedAt: sessionDocs[0].lastUsedAt,
          createdAt: sessionDocs[0].createdAt,
          expiresAt: sessionDocs[0].expiresAt,
          isCurrent: false,
        },
      ]);
      expect(result[0]).not.toHaveProperty("refreshTokenHash");
    });

    it("marks the session matching the current raw refresh token as isCurrent", async () => {
      const tokenHash = crypto
        .createHash("sha256")
        .update(VALID_REFRESH_TOKEN)
        .digest("hex");
      mockSessionModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: VALID_SESSION_ID,
              refreshTokenHash: tokenHash,
              lastUsedAt: new Date(),
              createdAt: new Date(),
              expiresAt: new Date(),
            },
          ]),
        }),
      });

      const result = await service.getSessions(
        VALID_USER_ID,
        VALID_REFRESH_TOKEN
      );

      expect(result[0].isCurrent).toBe(true);
    });
  });

  describe("revokeSession", () => {
    it("throws BadRequestException when sessionId is not a valid ObjectId", async () => {
      await expect(
        service.revokeSession(VALID_USER_ID, "not-an-object-id")
      ).rejects.toThrow(BadRequestException);
      expect(mockSessionModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("throws NotFoundException when the session does not belong to the caller or is already revoked", async () => {
      mockSessionModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.revokeSession(VALID_USER_ID, VALID_SESSION_ID)
      ).rejects.toThrow(NotFoundException);
    });

    it("revokes exactly the caller's own session (ownership scoped by userId filter)", async () => {
      mockSessionModel.findOneAndUpdate.mockResolvedValue({
        _id: VALID_SESSION_ID,
      });

      const result = await service.revokeSession(
        VALID_USER_ID,
        VALID_SESSION_ID
      );

      expect(mockSessionModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: VALID_SESSION_ID,
          userId: expect.anything(),
          revokedAt: null,
        }),
        { $set: { revokedAt: expect.any(Date) } }
      );
      expect(result.message).toBe("Session revoked successfully");
    });
  });

  describe("forgotPassword", () => {
    it("should tra ve message chung neu email khong ton tai", async () => {
      mockUserModel.findOne.mockResolvedValue(null);

      const result = await service.forgotPassword("notfound@mail.com");

      expect(result.message).toBeDefined();
      expect(mockMailService.sendPasswordResetEmail).not.toHaveBeenCalled();
    });

    it("should tao reset token, gui email va tra ve message chung", async () => {
      mockUserModel.findOne.mockResolvedValue({
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
      });
      mockResetTokenModel.deleteMany.mockResolvedValue({});
      mockResetTokenModel.create.mockResolvedValue({});

      const result = await service.forgotPassword(VALID_EMAIL);

      expect(mockResetTokenModel.deleteMany).toHaveBeenCalledWith(
        { userId: VALID_USER_ID, isUsed: false },
        expect.objectContaining({ session: expect.anything() })
      );
      expect(mockResetTokenModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            userId: VALID_USER_ID,
            isUsed: false,
            token: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        ],
        expect.objectContaining({ session: expect.anything() })
      );
      expect(
        mockUserEventsService.emitPasswordResetRequested
      ).toHaveBeenCalledWith(VALID_EMAIL, expect.any(String), undefined);
      expect(result.message).toContain("password reset link");
    });

    it("returns the exact same message whether or not the email exists (no enumeration)", async () => {
      mockUserModel.findOne.mockResolvedValueOnce(null);
      const notFoundResult = await service.forgotPassword("notfound@mail.com");

      mockUserModel.findOne.mockResolvedValueOnce({
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
      });
      mockResetTokenModel.deleteMany.mockResolvedValue({});
      mockResetTokenModel.create.mockResolvedValue({});
      const foundResult = await service.forgotPassword(VALID_EMAIL);

      expect(foundResult.message).toBe(notFoundResult.message);
    });
  });

  describe("resetPassword", () => {
    it("should throw BadRequestException neu passwords do not match", async () => {
      await expect(
        service.resetPassword({
          resetToken: VALID_RESET_TOKEN,
          newPassword: "NewPass123!",
          confirmPassword: "Different999!",
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException neu token khong hop le", async () => {
      mockResetTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockResetTokenModel.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          resetToken: "bad_token",
          newPassword: "NewPass123!",
          confirmPassword: "NewPass123!",
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException neu token da het han", async () => {
      mockResetTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockResetTokenModel.findOne.mockResolvedValue({
        token: EXPIRED_RESET_TOKEN,
        userId: VALID_USER_ID,
        isUsed: false,
        expiresAt: new Date(Date.now() - 1000),
      });

      await expect(
        service.resetPassword({
          resetToken: EXPIRED_RESET_TOKEN,
          newPassword: "NewPass123!",
          confirmPassword: "NewPass123!",
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw BadRequestException neu token da duoc su dung", async () => {
      mockResetTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockResetTokenModel.findOne.mockResolvedValue({
        token: USED_RESET_TOKEN,
        userId: VALID_USER_ID,
        isUsed: true,
        expiresAt: new Date(Date.now() + 3600000),
      });

      await expect(
        service.resetPassword({
          resetToken: USED_RESET_TOKEN,
          newPassword: "NewPass123!",
          confirmPassword: "NewPass123!",
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw NotFoundException neu userId khong tim duoc user", async () => {
      mockResetTokenModel.findOneAndUpdate.mockResolvedValue({
        token: VALID_RESET_TOKEN,
        userId: VALID_USER_ID,
        isUsed: false,
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockUserModel.findById.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          resetToken: VALID_RESET_TOKEN,
          newPassword: "NewPass123!",
          confirmPassword: "NewPass123!",
        })
      ).rejects.toThrow(NotFoundException);
    });

    it("should dat lai password thanh cong, revoke all sessions va invalidate cache", async () => {
      const saveMock = jest.fn().mockResolvedValue(undefined);
      const fakeUser = {
        _id: { toString: () => VALID_USER_ID },
        id: VALID_USER_ID,
        password: "",
        save: saveMock,
      };

      mockResetTokenModel.findOneAndUpdate.mockResolvedValue({
        token: VALID_RESET_TOKEN,
        userId: VALID_USER_ID,
        isUsed: false,
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockUserModel.findById.mockResolvedValue(fakeUser);

      const result = await service.resetPassword({
        resetToken: VALID_RESET_TOKEN,
        newPassword: "NewPass123!",
        confirmPassword: "NewPass123!",
      });

      expect(saveMock).toHaveBeenCalled();
      expect(fakeUser.password).toBe("NewPass123!");
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.anything(),
          revokedAt: null,
        }),
        { $set: { revokedAt: expect.any(Date) } }
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`
      );
      expect(result.message).toContain("reset successfully");
    });
  });

  describe("verifyEmail", () => {
    const VALID_VERIFICATION_TOKEN = "a".repeat(64);

    it("throws BadRequestException when token does not exist", async () => {
      mockEmailVerificationTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockEmailVerificationTokenModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.verifyEmail({ token: VALID_VERIFICATION_TOKEN })
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when token has expired", async () => {
      mockEmailVerificationTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockEmailVerificationTokenModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          userId: VALID_USER_ID,
          isUsed: false,
          expiresAt: new Date(Date.now() - 1000),
        }),
      });

      await expect(
        service.verifyEmail({ token: VALID_VERIFICATION_TOKEN })
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when token has already been used", async () => {
      mockEmailVerificationTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockEmailVerificationTokenModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          userId: VALID_USER_ID,
          isUsed: true,
          expiresAt: new Date(Date.now() + 3600000),
        }),
      });

      await expect(
        service.verifyEmail({ token: VALID_VERIFICATION_TOKEN })
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when the token's user no longer exists", async () => {
      mockEmailVerificationTokenModel.findOneAndUpdate.mockResolvedValue({
        userId: VALID_USER_ID,
        isUsed: false,
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockUserModel.findByIdAndUpdate.mockResolvedValue(null);

      await expect(
        service.verifyEmail({ token: VALID_VERIFICATION_TOKEN })
      ).rejects.toThrow(NotFoundException);
    });

    it("marks the token used, sets isVerified=true and invalidates user cache", async () => {
      mockEmailVerificationTokenModel.findOneAndUpdate.mockResolvedValue({
        userId: VALID_USER_ID,
        isUsed: false,
        expiresAt: new Date(Date.now() + 3600000),
      });
      mockUserModel.findByIdAndUpdate.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
      });

      const result = await service.verifyEmail({
        token: VALID_VERIFICATION_TOKEN,
      });

      expect(
        mockEmailVerificationTokenModel.findOneAndUpdate
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          isUsed: false,
          expiresAt: expect.anything(),
        }),
        { isUsed: true },
        expect.objectContaining({ session: expect.anything() })
      );
      expect(mockUserModel.findByIdAndUpdate).toHaveBeenCalledWith(
        VALID_USER_ID,
        { isVerified: true },
        expect.objectContaining({ new: true, session: expect.anything() })
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`
      );
      expect(result.message).toContain("verified");
    });
  });

  describe("resendVerificationEmail", () => {
    it("returns a generic message and does nothing when the user does not exist", async () => {
      mockUserModel.findOne.mockResolvedValue(null);

      const result = await service.resendVerificationEmail("notfound@mail.com");

      expect(result.message).toBeDefined();
      expect(mockEmailVerificationTokenModel.create).not.toHaveBeenCalled();
      expect(
        mockUserEventsService.emitEmailVerificationRequested
      ).not.toHaveBeenCalled();
    });

    it("returns the same generic message and does nothing when the user is already verified", async () => {
      mockUserModel.findOne.mockResolvedValue({
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        isVerified: true,
      });

      const result = await service.resendVerificationEmail(VALID_EMAIL);

      expect(result.message).toBeDefined();
      expect(mockEmailVerificationTokenModel.create).not.toHaveBeenCalled();
    });

    it("invalidates old tokens, creates a new one and emits the verification event", async () => {
      mockUserModel.findOne.mockResolvedValue({
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        fullName: "Test User",
        isVerified: false,
      });

      const result = await service.resendVerificationEmail(VALID_EMAIL);

      expect(mockEmailVerificationTokenModel.deleteMany).toHaveBeenCalledWith(
        { userId: VALID_USER_ID },
        expect.objectContaining({ session: expect.anything() })
      );
      expect(mockEmailVerificationTokenModel.create).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            userId: VALID_USER_ID,
            tokenHash: expect.any(String),
            expiresAt: expect.any(Date),
          }),
        ],
        expect.objectContaining({ session: expect.anything() })
      );
      expect(
        mockUserEventsService.emitEmailVerificationRequested
      ).toHaveBeenCalledWith(VALID_EMAIL, expect.any(String), "Test User");
      expect(result.message).toBeDefined();
    });
  });

  describe("changePassword", () => {
    it("should throw NotFoundException neu userId khong ton tai", async () => {
      mockUserModel.findById.mockResolvedValue(null);

      await expect(
        service.changePassword(VALID_USER_ID, {
          oldPassword: "old",
          newPassword: "new",
        } as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw UnauthorizedException neu oldPassword sai", async () => {
      mockUserModel.findById.mockResolvedValue({
        comparePassword: jest.fn().mockResolvedValue(false),
      });

      await expect(
        service.changePassword(VALID_USER_ID, {
          oldPassword: "wrong",
          newPassword: "NewPass123!",
        } as any)
      ).rejects.toThrow(UnauthorizedException);
    });

    it("should doi password thanh cong va invalidate cache", async () => {
      const saveMock = jest.fn().mockResolvedValue(undefined);
      const fakeUser = {
        _id: VALID_USER_ID,
        password: "old_hashed",
        comparePassword: jest.fn().mockResolvedValue(true),
        save: saveMock,
      };

      mockUserModel.findById.mockResolvedValue(fakeUser);

      const result = await service.changePassword(VALID_USER_ID, {
        oldPassword: VALID_PASSWORD,
        newPassword: "NewPass123!",
      } as any);

      expect(saveMock).toHaveBeenCalled();
      expect(fakeUser.password).toBe("NewPass123!");
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`
      );
      expect(result.message).toBe("Password changed successfully");
    });
  });

  describe("getUserById", () => {
    it("should tra ve user tu cache neu co", async () => {
      const cachedUser = {
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        avatarPublicId: null,
      };
      // getUserById now uses raw Redis client (not cacheManager)
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cachedUser));

      const result = await service.getUserById(VALID_USER_ID);

      expect(mockRedisClient.get).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`
      );
      expect(mockUserModel.findById).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("should tra ve null neu user khong ton tai trong DB", async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);
      mockUserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(null),
      });

      const result = await service.getUserById(VALID_USER_ID);

      expect(result).toBeNull();
    });

    it("should lay tu DB, luu vao cache va tra ve profile khong co avatarPublicId", async () => {
      const dbUser = {
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        fullName: "Test User",
        avatarPublicId: null,
      };

      mockRedisClient.get.mockResolvedValueOnce(null);
      mockUserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(dbUser),
      });

      const result = await service.getUserById(VALID_USER_ID);

      expect(mockRedisClient.set).toHaveBeenCalledWith(
        `user:details:v1:${VALID_USER_ID}`,
        JSON.stringify(dbUser),
        { EX: 300 }
      );
      expect(result).not.toHaveProperty("avatarPublicId");
      expect((result as any).avatarUrl).toBeNull();
    });

    it("should tao signed Cloudinary URL neu co avatarPublicId", async () => {
      const dbUser = {
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        avatarPublicId: "folder/my_avatar",
      };

      mockRedisClient.get.mockResolvedValueOnce(null);
      mockUserModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(dbUser),
      });

      const result = await service.getUserById(VALID_USER_ID);

      expect((result as any).avatarUrl).toBe(
        "https://mocked-cloudinary-url.com/image"
      );
    });
  });

  describe("register – additional edge cases", () => {
    it("should re-throw non-duplicate error as-is", async () => {
      const validationError = new Error("Validation failed");
      const saveMock = jest.fn().mockRejectedValue(validationError);
      mockUserModel.mockImplementation(() => ({ save: saveMock }));

      await expect(
        service.register({
          email: VALID_EMAIL,
          password: VALID_PASSWORD,
          confirmPassword: VALID_PASSWORD,
          fullName: "Test",
        } as any)
      ).rejects.toThrow("Validation failed");
    });

    it("should return user without password when toObject is available", async () => {
      const saveMock = jest.fn().mockResolvedValue(undefined);
      const fakeUser = {
        _id: VALID_USER_ID,
        email: VALID_EMAIL,
        password: "hashed",
        save: saveMock,
        toObject: jest.fn().mockReturnValue({
          _id: VALID_USER_ID,
          email: VALID_EMAIL,
          password: "hashed",
        }),
      };
      mockUserModel.mockImplementation(() => fakeUser);

      const result = await service.register({
        email: VALID_EMAIL,
        password: VALID_PASSWORD,
        confirmPassword: VALID_PASSWORD,
        fullName: "Test",
      } as any);

      expect(result).not.toHaveProperty("password");
    });
  });

  describe("generateUserTokens – disabled account", () => {
    it("should throw ForbiddenException when user is not active", async () => {
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: false,
      });

      await expect(service.generateUserTokens(VALID_USER_ID)).rejects.toThrow(
        "Account has been disabled"
      );
    });
  });

  describe("loginWithGoogle", () => {
    it("should throw BadRequestException when email is missing", async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(service.loginWithGoogle({} as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it("should upsert user and return tokens when email is provided", async () => {
      const mockUser = {
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      };
      mockUserModel.findOneAndUpdate.mockResolvedValue(mockUser);
      mockUserModel.findById.mockResolvedValue(mockUser);

      const result = await service.loginWithGoogle({
        email: VALID_EMAIL,
        name: "Google User",
        picture: "https://google.com/photo.jpg",
      });

      expect(mockUserModel.findOneAndUpdate).toHaveBeenCalledWith(
        { email: VALID_EMAIL },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({
            email: VALID_EMAIL,
            fullName: "Google User",
          }),
        }),
        expect.objectContaining({ upsert: true, new: true })
      );
      expect(result).toHaveProperty("accessToken");
      expect(result).toHaveProperty("refreshToken");
    });

    it("should throw TypeError when findOneAndUpdate returns null", async () => {
      mockUserModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.loginWithGoogle({
          email: VALID_EMAIL,
          name: "Google User",
        })
      ).rejects.toThrow(TypeError);
    });
  });

  describe("refreshToken – shadow token detection", () => {
    it("should revoke all sessions when shadow token is detected", async () => {
      mockSessionModel.findOne.mockResolvedValue(null);
      mockRedisClient.get.mockResolvedValueOnce(VALID_USER_ID);
      const response = createResponseMock();

      await expect(
        service.refreshToken(VALID_REFRESH_TOKEN, META, response as any)
      ).rejects.toThrow(UnauthorizedException);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("SECURITY")
      );
      expect(mockSessionModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: expect.anything(),
          revokedAt: null,
        }),
        { $set: { revokedAt: expect.any(Date) } }
      );
    });
  });

  describe("handleGoogleLoginCallback", () => {
    it("should throw BadRequestException when profile is missing", async () => {
      const response = createResponseMock();

      await expect(
        service.handleGoogleLoginCallback(undefined, META, response as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should set cookies and redirect when profile is valid with FRONTEND_URL", async () => {
      const mockProfile = { email: VALID_EMAIL, name: "Google User" };
      const response = createResponseMock();
      mockUserModel.findOneAndUpdate.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
      });
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });
      process.env.FRONTEND_URL = "http://localhost:3000";

      await service.handleGoogleLoginCallback(
        mockProfile as any,
        META,
        response as any
      );

      expect(response.cookie).toHaveBeenCalledTimes(2);
      expect(response.redirect).toHaveBeenCalledWith("http://localhost:3000/");

      delete process.env.FRONTEND_URL;
    });

    it("should redirect to / when FRONTEND_URL is not set", async () => {
      const mockProfile = { email: VALID_EMAIL, name: "Google User" };
      const response = createResponseMock();
      mockUserModel.findOneAndUpdate.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
      });
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });
      delete process.env.FRONTEND_URL;

      await service.handleGoogleLoginCallback(
        mockProfile as any,
        META,
        response as any
      );

      expect(response.redirect).toHaveBeenCalledWith("/");
    });
  });

  describe("resetPassword – additional edge cases", () => {
    it("should throw BadRequestException when valid UUID token not found in DB at all", async () => {
      mockResetTokenModel.findOneAndUpdate.mockResolvedValue(null);
      mockResetTokenModel.findOne.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          resetToken: VALID_RESET_TOKEN,
          newPassword: "NewPass123!",
          confirmPassword: "NewPass123!",
        })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("status and getCurrentUser", () => {
    it("should return logged in status message", () => {
      const result = service.status();
      expect(result).toEqual({ message: "Logged in successfully" });
    });

    it("should return currentUser from request", () => {
      const req = { currentUser: { userId: VALID_USER_ID, role: "user" } };
      const result = service.getCurrentUser(req);
      expect(result).toEqual({ userId: VALID_USER_ID, role: "user" });
    });
  });

  describe("withPassword – select path via changePassword", () => {
    afterEach(() => {
      mockUserModel.findById.mockReset();
    });

    it("should call select when findById returns query-like object", async () => {
      const querySelect = jest.fn().mockReturnThis();
      const fakeUser = {
        _id: VALID_USER_ID,
        password: "hashed",
        comparePassword: jest.fn().mockResolvedValue(true),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const queryLike = {
        select: querySelect,
        then: jest.fn((onFulfilled: (v: any) => any) =>
          Promise.resolve(onFulfilled(fakeUser))
        ),
      };
      mockUserModel.findById.mockReturnValue(queryLike);
      mockRedisClient.del.mockResolvedValue(1);

      const result = await service.changePassword(VALID_USER_ID, {
        oldPassword: "OldPass1!",
        newPassword: "NewPass1!",
      } as any);

      expect(querySelect).toHaveBeenCalledWith("+password");
      expect(result.message).toBe("Password changed successfully");
    });
  });

  describe("cookie options – env config", () => {
    afterEach(() => {
      delete process.env.AUTH_COOKIE_SECURE;
      delete process.env.AUTH_COOKIE_SAME_SITE;
      delete process.env.AUTH_COOKIE_DOMAIN;
    });

    it("should return secure=true when AUTH_COOKIE_SECURE is set to true", async () => {
      process.env.AUTH_COOKIE_SECURE = "true";
      const fakeUser = {
        _id: VALID_USER_ID,
        role: "user",
        comparePassword: jest.fn().mockResolvedValue(true),
      };
      const response = createResponseMock();
      mockUserModel.findOne.mockResolvedValue(fakeUser);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });

      await service.login(
        { email: VALID_EMAIL, password: VALID_PASSWORD } as any,
        META,
        response as any
      );

      expect(response.cookie).toHaveBeenCalledWith(
        "access_token",
        expect.any(String),
        expect.objectContaining({ secure: true })
      );
    });

    it("should fallback sameSite to lax for invalid AUTH_COOKIE_SAME_SITE value", async () => {
      process.env.AUTH_COOKIE_SAME_SITE = "invalid";
      const fakeUser = {
        _id: VALID_USER_ID,
        role: "user",
        comparePassword: jest.fn().mockResolvedValue(true),
      };
      const response = createResponseMock();
      mockUserModel.findOne.mockResolvedValue(fakeUser);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });

      await service.login(
        { email: VALID_EMAIL, password: VALID_PASSWORD } as any,
        META,
        response as any
      );

      expect(response.cookie).toHaveBeenCalledWith(
        "access_token",
        expect.any(String),
        expect.objectContaining({ sameSite: "lax" })
      );
    });

    it("should include domain when AUTH_COOKIE_DOMAIN is set", async () => {
      process.env.AUTH_COOKIE_DOMAIN = ".example.com";
      const fakeUser = {
        _id: VALID_USER_ID,
        role: "user",
        comparePassword: jest.fn().mockResolvedValue(true),
      };
      const response = createResponseMock();
      mockUserModel.findOne.mockResolvedValue(fakeUser);
      mockUserModel.findById.mockResolvedValue({
        _id: { toString: () => VALID_USER_ID },
        role: "user",
        isActive: true,
      });

      await service.login(
        { email: VALID_EMAIL, password: VALID_PASSWORD } as any,
        META,
        response as any
      );

      expect(response.cookie).toHaveBeenCalledWith(
        "access_token",
        expect.any(String),
        expect.objectContaining({ domain: ".example.com" })
      );
    });
  });
});
