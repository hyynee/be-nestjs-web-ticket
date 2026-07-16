import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import envConfig from "@src/config/config";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { RedisService } from "@src/redis/redis.service";
import { User } from "@src/schemas/user.schema";
import { TwoFactorService } from "@src/two-factor/two-factor.service";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";
import { LoginDTO } from "../dto/login.dto";
import { Model } from "mongoose";
import { Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { TWO_FACTOR_PENDING_TTL_SECONDS } from "../auth.constants";
import {
  AuthMessageResult,
  AuthTokenPair,
  GoogleProfile,
  LoginResult,
  SessionRequestMeta,
} from "../domain/types/auth.types";
import { withPassword } from "../domain/utils/auth-document.utils";
import { AuthCookieService } from "../infrastructure/http/auth-cookie.service";
import { AuthPresenter } from "../presenters/auth.presenter";
import { AuthSessionService } from "./auth-session.service";

@Injectable()
export class AuthLoginService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly loginAttemptService: LockLoginService,
    private readonly redisService: RedisService,
    private readonly twoFactorService: TwoFactorService,
    private readonly authCookieService: AuthCookieService,
    private readonly authPresenter: AuthPresenter,
    private readonly authSessionService: AuthSessionService
  ) {}

  private getTwoFactorPendingKey(token: string): string {
    return `auth:2fa-pending:${token}`;
  }

  private async createTwoFactorPendingLogin(userId: string): Promise<string> {
    const token = uuidv4();
    await this.redisService.client.set(
      this.getTwoFactorPendingKey(token),
      userId,
      { EX: TWO_FACTOR_PENDING_TTL_SECONDS }
    );
    return token;
  }

  async login(
    data: LoginDTO,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<LoginResult> {
    const { email, password } = data;
    const ip = meta.ipAddress || "unknown";
    const user = await withPassword(this.userModel.findOne({ email }));

    if (!user) {
      await this.loginAttemptService.recordFailedAttempt(email, ip);
      throw new UnauthorizedException("Invalid credentials");
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      await this.loginAttemptService.recordFailedAttempt(email, ip);
      throw new UnauthorizedException("Invalid credentials");
    }

    await this.loginAttemptService.resetLocked(email, ip);

    if (user.twoFactorEnabled) {
      const twoFactorToken = await this.createTwoFactorPendingLogin(
        user._id.toString()
      );
      return this.authPresenter.twoFactorRequired(twoFactorToken);
    }

    const tokens = await this.authSessionService.generateUserTokens(
      user._id,
      meta
    );

    this.authCookieService.setTokenCookies(res, tokens);
    return this.authPresenter.message("Logged in successfully");
  }

  async completeTwoFactorLogin(
    twoFactorToken: string,
    otp: string,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<AuthMessageResult> {
    if (!twoFactorToken || !UUID_V4_REGEX.test(twoFactorToken)) {
      throw new UnauthorizedException("Invalid or expired login session");
    }

    const pendingKey = this.getTwoFactorPendingKey(twoFactorToken);
    const userId = await this.redisService.client.getDel(pendingKey);
    if (!userId) {
      throw new UnauthorizedException("Invalid or expired login session");
    }

    const isValidOtp = await this.twoFactorService.verifyLoginOtp(userId, otp);
    if (!isValidOtp) {
      throw new UnauthorizedException("Invalid OTP or recovery code");
    }

    const tokens = await this.authSessionService.generateUserTokens(
      userId,
      meta
    );
    this.authCookieService.setTokenCookies(res, tokens);
    return this.authPresenter.message("Logged in successfully");
  }

  async loginWithGoogle(
    profile: GoogleProfile,
    meta: SessionRequestMeta = {}
  ): Promise<AuthTokenPair> {
    const { email, name } = profile;
    if (!email) {
      throw new BadRequestException(
        "Invalid Google profile: email is required"
      );
    }
    const user = await this.userModel.findOneAndUpdate(
      { email },
      {
        $setOnInsert: {
          email,
          fullName: name || email.split("@")[0],
          role: "user",
        },
      },
      { upsert: true, new: true }
    );
    return this.authSessionService.generateUserTokens(user!._id, meta);
  }

  async handleGoogleLoginCallback(
    profile: GoogleProfile | undefined,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<void> {
    if (!profile) {
      throw new BadRequestException(
        "Invalid Google profile: profile is required"
      );
    }

    const tokens = await this.loginWithGoogle(profile, meta);
    this.authCookieService.setTokenCookies(res, tokens);

    const frontendBaseUrl = envConfig.FRONTEND_URL?.replace(/\/+$/, "");
    const redirectTarget = frontendBaseUrl ? `${frontendBaseUrl}/` : "/";

    res.redirect(redirectTarget);
  }
}
