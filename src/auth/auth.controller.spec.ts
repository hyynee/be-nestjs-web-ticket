import { Test, TestingModule } from "@nestjs/testing";
import { AuthGuard } from "@nestjs/passport";
import { LockLoginGuard } from "@src/guards/lock-login.guard";
import { AuthAccountService } from "./application/auth-account.service";
import { AuthLoginService } from "./application/auth-login.service";
import { AuthPasswordService } from "./application/auth-password.service";
import { AuthSessionService } from "./application/auth-session.service";
import { AuthUserQueryService } from "./application/auth-user-query.service";
import { AuthAccountController } from "./controllers/auth-account.controller";
import { AuthOAuthController } from "./controllers/auth-oauth.controller";
import { AuthSessionController } from "./controllers/auth-session.controller";

describe("Auth controllers", () => {
  let accountController: AuthAccountController;
  let oauthController: AuthOAuthController;
  let sessionController: AuthSessionController;

  const mockAccountService = {
    register: jest.fn(),
    verifyEmail: jest.fn(),
    resendVerificationEmail: jest.fn(),
  };

  const mockLoginService = {
    login: jest.fn(),
    completeTwoFactorLogin: jest.fn(),
    handleGoogleLoginCallback: jest.fn(),
  };

  const mockPasswordService = {
    changePassword: jest.fn(),
    forgotPassword: jest.fn(),
    resetPassword: jest.fn(),
  };

  const mockSessionService = {
    refreshToken: jest.fn(),
    logout: jest.fn(),
    logoutAll: jest.fn(),
    getSessions: jest.fn(),
    revokeSession: jest.fn(),
  };

  const mockUserQueryService = {
    status: jest.fn(),
    getUserById: jest.fn(),
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
      controllers: [
        AuthAccountController,
        AuthOAuthController,
        AuthSessionController,
      ],
      providers: [
        { provide: AuthAccountService, useValue: mockAccountService },
        { provide: AuthLoginService, useValue: mockLoginService },
        { provide: AuthPasswordService, useValue: mockPasswordService },
        { provide: AuthSessionService, useValue: mockSessionService },
        { provide: AuthUserQueryService, useValue: mockUserQueryService },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(AuthGuard("google"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(LockLoginGuard)
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .compile();

    accountController = module.get<AuthAccountController>(
      AuthAccountController
    );
    oauthController = module.get<AuthOAuthController>(AuthOAuthController);
    sessionController = module.get<AuthSessionController>(
      AuthSessionController
    );
  });

  it("should be defined", () => {
    expect(accountController).toBeDefined();
    expect(oauthController).toBeDefined();
    expect(sessionController).toBeDefined();
  });

  it("registers a user through AuthAccountService", async () => {
    const dto = {
      email: "test@test.com",
      password: "Test123!@",
      confirmPassword: "Test123!@",
      fullName: "Test User",
    };
    mockAccountService.register.mockResolvedValue({
      id: "new-id",
      email: dto.email,
    });

    const result = await accountController.register(dto as any);

    expect(mockAccountService.register).toHaveBeenCalledWith(dto);
    expect(result).toEqual({ id: "new-id", email: dto.email });
  });

  it("logs in with request metadata and response passthrough", async () => {
    const loginDto = { email: "test@test.com", password: "Test123!@" };
    const req = mockReq();
    const res = mockRes();
    mockLoginService.login.mockResolvedValue({
      message: "Logged in successfully",
    });

    const result = await sessionController.login(loginDto as any, req, res);

    expect(mockLoginService.login).toHaveBeenCalledWith(
      loginDto,
      { ipAddress: req.ip, userAgent: "jest-test-agent" },
      res
    );
    expect(result).toEqual({ message: "Logged in successfully" });
  });

  it("completes 2FA login with request metadata and response passthrough", async () => {
    const dto = { twoFactorToken: "token-1", otp: "123456" };
    const req = mockReq();
    const res = mockRes();
    mockLoginService.completeTwoFactorLogin.mockResolvedValue({
      message: "Logged in successfully",
    });

    const result = await sessionController.completeTwoFactorLogin(
      dto as any,
      req,
      res
    );

    expect(mockLoginService.completeTwoFactorLogin).toHaveBeenCalledWith(
      "token-1",
      "123456",
      { ipAddress: req.ip, userAgent: "jest-test-agent" },
      res
    );
    expect(result).toEqual({ message: "Logged in successfully" });
  });

  it("handles Google callback through AuthLoginService", async () => {
    const req = mockReq({ user: { email: "test@test.com" } });
    const res = mockRes();
    mockLoginService.handleGoogleLoginCallback.mockResolvedValue(undefined);

    await oauthController.googleLoginCallback(req, res);

    expect(mockLoginService.handleGoogleLoginCallback).toHaveBeenCalledWith(
      req.user,
      { ipAddress: req.ip, userAgent: "jest-test-agent" },
      res
    );
  });

  it("returns auth status through AuthUserQueryService", () => {
    mockUserQueryService.status.mockReturnValue({
      message: "Logged in successfully",
    });

    const result = sessionController.status();

    expect(mockUserQueryService.status).toHaveBeenCalled();
    expect(result).toEqual({ message: "Logged in successfully" });
  });

  it("refreshes token from cookie and passes empty string when missing", async () => {
    const req = mockReq({ cookies: { refresh_token: "valid-uuid" } });
    const res = mockRes();
    mockSessionService.refreshToken.mockResolvedValue({
      message: "Token refreshed successfully",
    });

    const result = await sessionController.refreshToken(req, res);

    expect(mockSessionService.refreshToken).toHaveBeenCalledWith(
      "valid-uuid",
      { ipAddress: req.ip, userAgent: "jest-test-agent" },
      res
    );
    expect(result).toEqual({ message: "Token refreshed successfully" });

    await sessionController.refreshToken(mockReq(), res);
    expect(mockSessionService.refreshToken).toHaveBeenLastCalledWith(
      "",
      expect.any(Object),
      res
    );
  });

  it("loads current user profile by current JWT user id", async () => {
    const userData = { id: "user-1", email: "test@test.com" };
    mockUserQueryService.getUserById.mockResolvedValue(userData);

    const result = await accountController.getCurrentUser(mockCurrentUser);

    expect(mockUserQueryService.getUserById).toHaveBeenCalledWith("user-1");
    expect(result).toEqual(userData);
  });

  it("logs out using refresh token from cookie when present", async () => {
    const req = mockReq({
      cookies: { refresh_token: "valid-uuid", access_token: "jwt-token" },
    });
    const res = mockRes();
    mockSessionService.logout.mockResolvedValue({
      message: "Logged out successfully",
    });

    const result = await sessionController.logout(req, res);

    expect(mockSessionService.logout).toHaveBeenCalledWith(
      "valid-uuid",
      res,
      req
    );
    expect(result).toEqual({ message: "Logged out successfully" });
  });

  it("logs out all sessions for current user", async () => {
    const req = mockReq();
    const res = mockRes();
    mockSessionService.logoutAll.mockResolvedValue({
      message: "Logged out from all devices successfully",
    });

    const result = await sessionController.logoutAll(mockCurrentUser, req, res);

    expect(mockSessionService.logoutAll).toHaveBeenCalledWith(
      "user-1",
      res,
      req
    );
    expect(result).toEqual({
      message: "Logged out from all devices successfully",
    });
  });

  it("lists sessions with current refresh token marker", async () => {
    const req = mockReq({ cookies: { refresh_token: "current-uuid" } });
    const sessions = [{ id: "session-1", isCurrent: true }];
    mockSessionService.getSessions.mockResolvedValue(sessions);

    const result = await sessionController.getSessions(mockCurrentUser, req);

    expect(mockSessionService.getSessions).toHaveBeenCalledWith(
      "user-1",
      "current-uuid"
    );
    expect(result).toEqual(sessions);
  });

  it("revokes one session owned by the current user", async () => {
    mockSessionService.revokeSession.mockResolvedValue({
      message: "Session revoked successfully",
    });

    const result = await sessionController.revokeSession(
      mockCurrentUser,
      "session-1"
    );

    expect(mockSessionService.revokeSession).toHaveBeenCalledWith(
      "user-1",
      "session-1"
    );
    expect(result).toEqual({ message: "Session revoked successfully" });
  });

  it("changes password for current user", async () => {
    const dto = { oldPassword: "Old123!", newPassword: "New123!" };
    mockPasswordService.changePassword.mockResolvedValue({
      message: "Password changed successfully",
    });

    const result = await accountController.changePassword(
      mockCurrentUser,
      dto as any
    );

    expect(mockPasswordService.changePassword).toHaveBeenCalledWith(
      "user-1",
      dto
    );
    expect(result).toEqual({ message: "Password changed successfully" });
  });

  it("runs password recovery and email verification commands", async () => {
    mockPasswordService.forgotPassword.mockResolvedValue({
      message: "forgot",
    });
    mockPasswordService.resetPassword.mockResolvedValue({
      message: "reset",
    });
    mockAccountService.verifyEmail.mockResolvedValue({
      message: "verified",
    });
    mockAccountService.resendVerificationEmail.mockResolvedValue({
      message: "resent",
    });

    await expect(
      accountController.forgotPassword({ email: "test@test.com" } as any)
    ).resolves.toEqual({ message: "forgot" });
    await expect(
      accountController.resetPassword({ resetToken: "token" } as any)
    ).resolves.toEqual({ message: "reset" });
    await expect(
      accountController.verifyEmail({ token: "token" } as any)
    ).resolves.toEqual({ message: "verified" });
    await expect(
      accountController.resendVerification({ email: "test@test.com" } as any)
    ).resolves.toEqual({ message: "resent" });

    expect(mockPasswordService.forgotPassword).toHaveBeenCalledWith(
      "test@test.com"
    );
    expect(mockPasswordService.resetPassword).toHaveBeenCalledWith({
      resetToken: "token",
    });
    expect(mockAccountService.verifyEmail).toHaveBeenCalledWith({
      token: "token",
    });
    expect(mockAccountService.resendVerificationEmail).toHaveBeenCalledWith(
      "test@test.com"
    );
  });
});
