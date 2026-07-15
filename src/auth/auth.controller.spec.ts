import { Test, TestingModule } from "@nestjs/testing";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { AuthGuard } from "@nestjs/passport";
import { LockLoginGuard } from "@src/guards/lock-login.guard";

describe("AuthController", () => {
  let controller: AuthController;
  let _authService: jest.Mocked<Partial<AuthService>>;

  const mockAuthService = {
    register: jest.fn(),
    login: jest.fn(),
    completeTwoFactorLogin: jest.fn(),
    handleGoogleLoginCallback: jest.fn(),
    status: jest.fn(),
    refreshToken: jest.fn(),
    getUserById: jest.fn(),
    logout: jest.fn(),
    logoutAll: jest.fn(),
    getSessions: jest.fn(),
    revokeSession: jest.fn(),
    changePassword: jest.fn(),
    forgotPassword: jest.fn(),
    resetPassword: jest.fn(),
    verifyEmail: jest.fn(),
    resendVerificationEmail: jest.fn(),
  };

  const mockRes = () => {
    const res: any = {};
    res.cookie = jest.fn().mockReturnValue(res);
    res.clearCookie = jest.fn().mockReturnValue(res);
    res.redirect = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  const mockReq = (overrides: Record<string, unknown> = {}) =>
    ({
      cookies: {},
      ip: "127.0.0.1",
      headers: { "user-agent": "jest-test-agent" },
      user: { userId: "user-1", role: "user" },
      ...overrides,
    }) as any;

  const mockCurrentUser = {
    userId: "user-1",
    role: "user",
    iat: 123,
    exp: 456,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: mockAuthService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(AuthGuard("google"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(LockLoginGuard)
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("POST /auth/register", () => {
    it("should call authService.register with the DTO", async () => {
      const dto = {
        email: "test@test.com",
        password: "Test123!@",
        confirmPassword: "Test123!@",
        fullName: "Test User",
      };
      mockAuthService.register.mockResolvedValue({
        _id: "new-id",
        email: dto.email,
      });

      const result = await controller.register(dto as any);

      expect(mockAuthService.register).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ _id: "new-id", email: dto.email });
    });

    it("should propagate error from authService.register", async () => {
      mockAuthService.register.mockRejectedValue(
        new Error("Email already exists")
      );

      await expect(controller.register({} as any)).rejects.toThrow(
        "Email already exists"
      );
    });
  });

  describe("POST /auth/login", () => {
    it("should call authService.login with DTO, session meta, and response", async () => {
      const loginDto = { email: "test@test.com", password: "Test123!@" };
      const req = mockReq();
      const res = mockRes();
      mockAuthService.login.mockResolvedValue({
        message: "Logged in successfully",
      });

      const result = await controller.login(loginDto as any, req, res);

      expect(mockAuthService.login).toHaveBeenCalledWith(
        loginDto,
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
      expect(result).toEqual({ message: "Logged in successfully" });
    });
  });

  describe("POST /auth/2fa/login", () => {
    it("should call authService.completeTwoFactorLogin with token, otp, session meta, and response", async () => {
      const dto = { twoFactorToken: "token-1", otp: "123456" };
      const req = mockReq();
      const res = mockRes();
      mockAuthService.completeTwoFactorLogin.mockResolvedValue({
        message: "Logged in successfully",
      });

      const result = await controller.completeTwoFactorLogin(
        dto as any,
        req,
        res
      );

      expect(mockAuthService.completeTwoFactorLogin).toHaveBeenCalledWith(
        "token-1",
        "123456",
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
      expect(result).toEqual({ message: "Logged in successfully" });
    });

    it("should propagate error from authService.completeTwoFactorLogin", async () => {
      mockAuthService.completeTwoFactorLogin.mockRejectedValue(
        new Error("Invalid OTP or recovery code")
      );

      await expect(
        controller.completeTwoFactorLogin(
          { twoFactorToken: "t", otp: "000000" } as any,
          mockReq(),
          mockRes()
        )
      ).rejects.toThrow("Invalid OTP or recovery code");
    });
  });

  describe("GET /auth/google", () => {
    it("should be defined and return Promise<void>", async () => {
      const result = controller.googleLogin();
      await expect(result).resolves.toBeUndefined();
    });
  });

  describe("GET /auth/google/callback", () => {
    it("should call authService.handleGoogleLoginCallback with user, session meta, and res", async () => {
      const req = mockReq({ user: { email: "google@user.com" } });
      const res = mockRes();
      mockAuthService.handleGoogleLoginCallback.mockResolvedValue(undefined);

      await controller.googleLoginCallback(req, res);

      expect(mockAuthService.handleGoogleLoginCallback).toHaveBeenCalledWith(
        req.user,
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
    });
  });

  describe("GET /auth/status", () => {
    it("should call authService.status", async () => {
      mockAuthService.status.mockReturnValue({
        message: "Logged in successfully",
      });

      const result = controller.status();

      expect(mockAuthService.status).toHaveBeenCalled();
      expect(result).toEqual({ message: "Logged in successfully" });
    });
  });

  describe("POST /auth/refresh-token", () => {
    it("should call authService.refreshToken with token from cookies", async () => {
      const req = mockReq({ cookies: { refresh_token: "valid-uu-id-here" } });
      const res = mockRes();
      mockAuthService.refreshToken.mockResolvedValue({
        message: "Token refreshed successfully",
      });

      const result = await controller.refreshToken(req, res);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith(
        "valid-uu-id-here",
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
      expect(result).toEqual({ message: "Token refreshed successfully" });
    });

    it("should pass empty string when refresh_token cookie is missing", async () => {
      const req = mockReq({ cookies: {} });
      const res = mockRes();
      mockAuthService.refreshToken.mockResolvedValue({
        message: "Token refreshed successfully",
      });

      await controller.refreshToken(req, res);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith(
        "",
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
    });

    it("should pass empty string when refresh_token is not a string", async () => {
      const req = mockReq({ cookies: { refresh_token: 123 } });
      const res = mockRes();

      await controller.refreshToken(req, res);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith(
        "",
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
    });

    it("should pass empty string when cookies is undefined", async () => {
      const req = mockReq({ cookies: undefined });
      const res = mockRes();

      await controller.refreshToken(req, res);

      expect(mockAuthService.refreshToken).toHaveBeenCalledWith(
        "",
        { ipAddress: req.ip, userAgent: "jest-test-agent" },
        res
      );
    });
  });

  describe("GET /auth/me", () => {
    it("should call authService.getUserById with currentUser.userId", async () => {
      const userData = { _id: "user-1", email: "test@test.com" };
      mockAuthService.getUserById.mockResolvedValue(userData);

      const result = await controller.getCurrentUser(mockCurrentUser as any);

      expect(mockAuthService.getUserById).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(userData);
    });
  });

  describe("POST /auth/logout", () => {
    it("should call authService.logout with refresh token from cookies", async () => {
      const req = mockReq({
        cookies: { refresh_token: "valid-uuid", access_token: "jwt-token" },
      });
      const res = mockRes();
      mockAuthService.logout.mockResolvedValue({
        message: "Logged out successfully",
      });

      const result = await controller.logout(req, res);

      expect(mockAuthService.logout).toHaveBeenCalledWith(
        "valid-uuid",
        res,
        req
      );
      expect(result).toEqual({ message: "Logged out successfully" });
    });

    it("should pass undefined when refresh_token cookie is missing", async () => {
      const req = mockReq({ cookies: {} });
      const res = mockRes();

      await controller.logout(req, res);

      expect(mockAuthService.logout).toHaveBeenCalledWith(undefined, res, req);
    });

    it("should pass undefined when refresh_token is not a string", async () => {
      const req = mockReq({ cookies: { refresh_token: 123 } });
      const res = mockRes();

      await controller.logout(req, res);

      expect(mockAuthService.logout).toHaveBeenCalledWith(undefined, res, req);
    });

    it("should pass undefined when cookies object is missing", async () => {
      const req = mockReq({ cookies: undefined });
      const res = mockRes();

      await controller.logout(req, res);

      expect(mockAuthService.logout).toHaveBeenCalledWith(undefined, res, req);
    });
  });

  describe("POST /auth/logout-all", () => {
    it("should call authService.logoutAll with currentUser.userId, res, and req", async () => {
      const req = mockReq();
      const res = mockRes();
      mockAuthService.logoutAll.mockResolvedValue({
        message: "Logged out from all devices successfully",
      });

      const result = await controller.logoutAll(
        mockCurrentUser as any,
        req,
        res
      );

      expect(mockAuthService.logoutAll).toHaveBeenCalledWith(
        "user-1",
        res,
        req
      );
      expect(result).toEqual({
        message: "Logged out from all devices successfully",
      });
    });
  });

  describe("GET /auth/sessions", () => {
    it("should call authService.getSessions with currentUser.userId and the current raw refresh token", async () => {
      const req = mockReq({ cookies: { refresh_token: "current-uuid" } });
      const sessions = [{ id: "s1", isCurrent: true }];
      mockAuthService.getSessions.mockResolvedValue(sessions);

      const result = await controller.getSessions(mockCurrentUser as any, req);

      expect(mockAuthService.getSessions).toHaveBeenCalledWith(
        "user-1",
        "current-uuid"
      );
      expect(result).toEqual(sessions);
    });

    it("should pass undefined when refresh_token cookie is missing", async () => {
      const req = mockReq({ cookies: {} });
      mockAuthService.getSessions.mockResolvedValue([]);

      await controller.getSessions(mockCurrentUser as any, req);

      expect(mockAuthService.getSessions).toHaveBeenCalledWith(
        "user-1",
        undefined
      );
    });
  });

  describe("DELETE /auth/sessions/:id", () => {
    it("should call authService.revokeSession with currentUser.userId and the session id", async () => {
      mockAuthService.revokeSession.mockResolvedValue({
        message: "Session revoked successfully",
      });

      const result = await controller.revokeSession(
        mockCurrentUser as any,
        "session-1"
      );

      expect(mockAuthService.revokeSession).toHaveBeenCalledWith(
        "user-1",
        "session-1"
      );
      expect(result).toEqual({ message: "Session revoked successfully" });
    });

    it("should propagate error from authService.revokeSession", async () => {
      mockAuthService.revokeSession.mockRejectedValue(
        new Error("Session not found or already revoked")
      );

      await expect(
        controller.revokeSession(mockCurrentUser as any, "session-1")
      ).rejects.toThrow("Session not found or already revoked");
    });
  });

  describe("PUT /auth/change-password", () => {
    it("should call authService.changePassword with userId and DTO", async () => {
      const dto = { oldPassword: "OldPass1!", newPassword: "NewPass1!" };
      mockAuthService.changePassword.mockResolvedValue({
        message: "Password changed successfully",
      });

      const result = await controller.changePassword(
        mockCurrentUser as any,
        dto as any
      );

      expect(mockAuthService.changePassword).toHaveBeenCalledWith(
        "user-1",
        dto
      );
      expect(result).toEqual({ message: "Password changed successfully" });
    });
  });

  describe("POST /auth/forgotPassword", () => {
    it("should call authService.forgotPassword with email", async () => {
      const forgotDto = { email: "test@test.com" };
      mockAuthService.forgotPassword.mockResolvedValue({
        message: "Reset link sent",
      });

      const result = await controller.forgotPassword(forgotDto as any);

      expect(mockAuthService.forgotPassword).toHaveBeenCalledWith(
        "test@test.com"
      );
      expect(result).toEqual({ message: "Reset link sent" });
    });
  });

  describe("POST /auth/resetPassword", () => {
    it("should call authService.resetPassword with DTO", async () => {
      const dto = {
        resetToken: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11",
        newPassword: "NewPass123!",
        confirmPassword: "NewPass123!",
      };
      mockAuthService.resetPassword.mockResolvedValue({
        message: "Password has been reset successfully",
      });

      const result = await controller.resetPassword(dto as any);

      expect(mockAuthService.resetPassword).toHaveBeenCalledWith(dto);
      expect(result).toEqual({
        message: "Password has been reset successfully",
      });
    });
  });

  describe("POST /auth/verify-email", () => {
    it("should call authService.verifyEmail with the DTO", async () => {
      const dto = { token: "a".repeat(64) };
      mockAuthService.verifyEmail.mockResolvedValue({
        message: "Email verified successfully.",
      });

      const result = await controller.verifyEmail(dto as any);

      expect(mockAuthService.verifyEmail).toHaveBeenCalledWith(dto);
      expect(result).toEqual({ message: "Email verified successfully." });
    });

    it("should propagate error from authService.verifyEmail", async () => {
      mockAuthService.verifyEmail.mockRejectedValue(
        new Error("Invalid or expired verification token")
      );

      await expect(
        controller.verifyEmail({ token: "a".repeat(64) } as any)
      ).rejects.toThrow("Invalid or expired verification token");
    });
  });

  describe("POST /auth/resend-verification", () => {
    it("should call authService.resendVerificationEmail with the email", async () => {
      const dto = { email: "test@test.com" };
      mockAuthService.resendVerificationEmail.mockResolvedValue({
        message: "generic message",
      });

      const result = await controller.resendVerification(dto as any);

      expect(mockAuthService.resendVerificationEmail).toHaveBeenCalledWith(
        "test@test.com"
      );
      expect(result).toEqual({ message: "generic message" });
    });
  });
});
