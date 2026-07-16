import { Injectable } from "@nestjs/common";
import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuthAccountService } from "./application/auth-account.service";
import { AuthLoginService } from "./application/auth-login.service";
import { AuthPasswordService } from "./application/auth-password.service";
import { AuthSessionService } from "./application/auth-session.service";
import { AuthUserQueryService } from "./application/auth-user-query.service";
import { RegisterDTO } from "./dto/create.dto";
import { LoginDTO } from "./dto/login.dto";
import { ChangePasswordDTO } from "./dto/password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import {
  AuthMessageResult,
  AuthTokenPair,
  AuthUserProfile,
  CurrentUserResult,
  GoogleProfile,
  LoginResult,
  SessionRequestMeta,
  SessionSummary,
} from "./domain/types/auth.types";

export type {
  AuthMessageResult,
  AuthTokenPair,
  AuthUserProfile,
  CurrentUserResult,
  GoogleProfile,
  LoginResult,
  SessionRequestMeta,
  SessionSummary,
  TwoFactorRequiredResult,
} from "./domain/types/auth.types";

@Injectable()
export class AuthService {
  constructor(
    private readonly authAccountService: AuthAccountService,
    private readonly authLoginService: AuthLoginService,
    private readonly authPasswordService: AuthPasswordService,
    private readonly authSessionService: AuthSessionService,
    private readonly authUserQueryService: AuthUserQueryService
  ) {}

  register(data: RegisterDTO): Promise<AuthUserProfile> {
    return this.authAccountService.register(data);
  }

  verifyEmail(data: VerifyEmailDto): Promise<AuthMessageResult> {
    return this.authAccountService.verifyEmail(data);
  }

  resendVerificationEmail(email: string): Promise<AuthMessageResult> {
    return this.authAccountService.resendVerificationEmail(email);
  }

  login(
    data: LoginDTO,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<LoginResult> {
    return this.authLoginService.login(data, meta, res);
  }

  completeTwoFactorLogin(
    twoFactorToken: string,
    otp: string,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<AuthMessageResult> {
    return this.authLoginService.completeTwoFactorLogin(
      twoFactorToken,
      otp,
      meta,
      res
    );
  }

  loginWithGoogle(
    profile: GoogleProfile,
    meta: SessionRequestMeta = {}
  ): Promise<AuthTokenPair> {
    return this.authLoginService.loginWithGoogle(profile, meta);
  }

  handleGoogleLoginCallback(
    profile: GoogleProfile | undefined,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<void> {
    return this.authLoginService.handleGoogleLoginCallback(profile, meta, res);
  }

  status(): AuthMessageResult {
    return this.authUserQueryService.status();
  }

  getCurrentUser(req: Request): CurrentUserResult {
    return this.authUserQueryService.getCurrentUser(req);
  }

  getUserById(id: string): Promise<AuthUserProfile | null> {
    return this.authUserQueryService.getUserById(id);
  }

  refreshToken(
    refreshToken: string,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<AuthMessageResult> {
    return this.authSessionService.refreshToken(refreshToken, meta, res);
  }

  logout(
    refreshToken: string | undefined,
    res: Response,
    req: Request
  ): Promise<AuthMessageResult> {
    return this.authSessionService.logout(refreshToken, res, req);
  }

  logoutAll(
    userId: string,
    res: Response,
    req: Request
  ): Promise<AuthMessageResult> {
    return this.authSessionService.logoutAll(userId, res, req);
  }

  getSessions(
    userId: string,
    currentRawToken?: string
  ): Promise<SessionSummary[]> {
    return this.authSessionService.getSessions(userId, currentRawToken);
  }

  revokeSession(userId: string, sessionId: string): Promise<AuthMessageResult> {
    return this.authSessionService.revokeSession(userId, sessionId);
  }

  generateUserTokens(
    userId: string | Types.ObjectId,
    meta: SessionRequestMeta = {}
  ): Promise<AuthTokenPair> {
    return this.authSessionService.generateUserTokens(userId, meta);
  }

  changePassword(
    userId: string,
    data: ChangePasswordDTO
  ): Promise<AuthMessageResult> {
    return this.authPasswordService.changePassword(userId, data);
  }

  forgotPassword(email: string): Promise<AuthMessageResult> {
    return this.authPasswordService.forgotPassword(email);
  }

  resetPassword(data: ResetPasswordDto): Promise<AuthMessageResult> {
    return this.authPasswordService.resetPassword(data);
  }
}
