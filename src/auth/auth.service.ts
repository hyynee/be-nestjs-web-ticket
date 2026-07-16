import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ServiceUnavailableException,
  Inject,
} from "@nestjs/common";
import { LoginDTO } from "./dto/login.dto";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { Model, Types } from "mongoose";
import { RegisterDTO } from "./dto/create.dto";
import { JwtService } from "@nestjs/jwt";
import { v4 as uuidv4 } from "uuid";
import * as crypto from "crypto";
import { ChangePasswordDTO } from "./dto/password.dto";
import envConfig from "@src/config/config";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { MailService } from "@src/services/mail.service";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ResetToken } from "@src/schemas/reset-token.schema";
import { EmailVerificationToken } from "@src/schemas/email-verification-token.schema";
import { Session } from "@src/schemas/session.schema";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { UserEventsService } from "@src/events/user-event.services";
import { v2 as cloudinary } from "cloudinary";
import { RedisService } from "@src/redis/redis.service";
import { CookieOptions, Response, Request } from "express";
import {
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  EMAIL_VERIFICATION_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  SHADOW_TTL_SECONDS,
  TWO_FACTOR_PENDING_TTL_SECONDS,
} from "./auth.constants";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";
import {
  parseDeviceInfo,
  sanitizeUserAgent,
} from "@src/common/utils/device.utils";
import { TwoFactorService } from "@src/two-factor/two-factor.service";

type GoogleProfile = {
  email?: string;
  name?: string;
  picture?: string;
};

const AUTH_USER_RESPONSE_SCHEMA_VERSION = "v1";

/** IP/User-Agent captured from the incoming request, attached to the session record created/rotated for that request. */
export interface SessionRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionSummary {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

export interface AuthMessageResult {
  message: string;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TwoFactorRequiredResult {
  status: "requires2fa";
  twoFactorToken: string;
}

export type LoginResult = AuthMessageResult | TwoFactorRequiredResult;
export type CurrentUserResult = Request["currentUser"];

interface AuthUserSource {
  _id?: Types.ObjectId | string;
  id?: string;
  email?: string;
  fullName?: string;
  phoneNumber?: string;
  role?: string;
  isVerified?: boolean;
  isActive?: boolean;
  twoFactorEnabled?: boolean;
  avatarPublicId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface ActiveAuthUser {
  _id: Types.ObjectId | string;
  role: string;
  isActive: boolean;
}

export interface AuthUserProfile {
  id: string;
  email?: string;
  fullName?: string;
  phoneNumber?: string;
  role?: string;
  isVerified: boolean;
  isActive: boolean;
  twoFactorEnabled: boolean;
  avatarUrl: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

type SessionLean = {
  _id: Types.ObjectId;
  refreshTokenHash: string;
  deviceInfo?: string;
  ipAddress?: string;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
};

interface PasswordSelectableQuery {
  select(fields: string): unknown;
}

interface ObjectSerializableDocument {
  toObject(): Record<string, unknown>;
}

function hasSelect(value: unknown): value is PasswordSelectableQuery {
  if (!value || typeof value !== "object" || !("select" in value)) {
    return false;
  }

  return typeof value.select === "function";
}

function hasToObject(value: unknown): value is ObjectSerializableDocument {
  if (!value || typeof value !== "object" || !("toObject" in value)) {
    return false;
  }

  return typeof value.toObject === "function";
}

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(ResetToken.name)
    private readonly resetTokenModel: Model<ResetToken>,
    @InjectModel(EmailVerificationToken.name)
    private readonly emailVerificationTokenModel: Model<EmailVerificationToken>,
    @InjectModel(Session.name) private readonly sessionModel: Model<Session>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,

    private jwtService: JwtService,
    private loginAttemptService: LockLoginService,
    private readonly userEventsService: UserEventsService,
    private mailService: MailService,
    private readonly redisService: RedisService,
    private readonly twoFactorService: TwoFactorService
  ) {}
  private generateCacheKeyForUser(userId: string): string {
    return `user:details:${AUTH_USER_RESPONSE_SCHEMA_VERSION}:${userId}`;
  }
  private async invalidateUserCache(userId: string): Promise<void> {
    const cacheKey = this.generateCacheKeyForUser(userId);
    await Promise.all([
      this.redisService.client.del(cacheKey).catch(() => {}),
      this.redisService.client.del(`auth:user-state:${userId}`).catch(() => {}),
    ]);
  }

  private getSessionShadowKey(refreshTokenHash: string): string {
    return `auth:shadow:${refreshTokenHash}`;
  }

  private getTwoFactorPendingKey(token: string): string {
    return `auth:2fa-pending:${token}`;
  }

  private withPassword<TQuery>(query: TQuery): TQuery {
    return hasSelect(query) ? (query.select("+password") as TQuery) : query;
  }

  private isCookieSecure(): boolean {
    const rawValue = envConfig.AUTH_COOKIE_SECURE;
    if (!rawValue) {
      return envConfig.NODE_ENV === "production";
    }

    return String(rawValue).toLowerCase() === "true";
  }

  private getCookieSameSite(): "lax" | "strict" | "none" {
    const rawValue = String(
      envConfig.AUTH_COOKIE_SAME_SITE || "lax"
    ).toLowerCase();
    if (rawValue === "lax" || rawValue === "strict" || rawValue === "none") {
      return rawValue;
    }
    return "lax";
  }

  private getTokenCookieOptions(maxAge: number): CookieOptions {
    const secure = this.isCookieSecure();
    const sameSite =
      this.getCookieSameSite() === "none" && !secure
        ? "lax"
        : this.getCookieSameSite();

    const cookieOptions: CookieOptions = {
      httpOnly: true,
      secure,
      sameSite,
      maxAge,
      path: "/",
    };

    if (envConfig.AUTH_COOKIE_DOMAIN) {
      cookieOptions.domain = envConfig.AUTH_COOKIE_DOMAIN;
    }

    return cookieOptions;
  }

  private setTokenCookies(
    res: Response,
    tokens: { accessToken: string; refreshToken: string }
  ): void {
    res.cookie(
      "access_token",
      tokens.accessToken,
      this.getTokenCookieOptions(ACCESS_TOKEN_TTL_MS)
    );
    res.cookie(
      "refresh_token",
      tokens.refreshToken,
      this.getTokenCookieOptions(REFRESH_TOKEN_TTL_MS)
    );
  }

  private clearTokenCookies(res: Response): void {
    const clearOptions = this.getTokenCookieOptions(0);
    res.clearCookie("access_token", clearOptions);
    res.clearCookie("refresh_token", clearOptions);
  }

  private authMessage(message: string): AuthMessageResult {
    return { message };
  }

  private twoFactorRequired(twoFactorToken: string): TwoFactorRequiredResult {
    return { status: "requires2fa", twoFactorToken };
  }

  private authTokenPair(
    accessToken: string,
    refreshToken: string
  ): AuthTokenPair {
    return { accessToken, refreshToken };
  }

  private async revokeAllUserSessions(
    userId: string | Types.ObjectId
  ): Promise<void> {
    await this.sessionModel.updateMany(
      { userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }

  private async getActiveUserOrThrow(
    userId: string | Types.ObjectId
  ): Promise<ActiveAuthUser> {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    if (!user.isActive) {
      throw new ForbiddenException("Account has been disabled");
    }
    return user;
  }

  private issueAccessToken(user: ActiveAuthUser): string {
    return this.jwtService.sign(
      { userId: user._id.toString(), role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
    );
  }

  /** Creates a brand-new session per device/login and leaves other user sessions untouched. */
  private async createSession(
    userId: Types.ObjectId,
    meta: SessionRequestMeta
  ): Promise<string> {
    const rawRefreshToken = uuidv4();
    const sanitizedUserAgent = sanitizeUserAgent(meta.userAgent);

    await this.sessionModel.create({
      userId,
      refreshTokenHash: this.hashToken(rawRefreshToken),
      ipAddress: meta.ipAddress,
      userAgent: sanitizedUserAgent,
      deviceInfo: parseDeviceInfo(sanitizedUserAgent),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    return rawRefreshToken;
  }

  private static isDuplicateKeyError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const code = (err as Record<string, unknown>).code;
    return code === 11000 || code === 11001;
  }

  /** SHA-256 hash of a raw token — the raw value is emailed to the user and never persisted. */
  private hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  private toAuthUserProfile(user: AuthUserSource): AuthUserProfile | null {
    const userId = user._id?.toString() ?? user.id;
    if (!userId) {
      return null;
    }

    const avatarUrl = user.avatarPublicId
      ? cloudinary.url(user.avatarPublicId, {
          type: "private",
          sign_url: true,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          secure: true,
        })
      : null;

    return {
      id: userId,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      role: user.role,
      isVerified: user.isVerified ?? false,
      isActive: user.isActive ?? true,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      avatarUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  async register(data: RegisterDTO): Promise<AuthUserProfile> {
    const { email, password, confirmPassword, fullName } = data;
    if (password !== confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }

    const rawVerificationToken = crypto.randomBytes(32).toString("hex");
    const session = await this.userModel.db.startSession();
    let createdUser!: User;

    try {
      await session.withTransaction(async () => {
        const user = new this.userModel({
          email,
          password,
          fullName,
          role: "user",
        });

        try {
          createdUser = (await user.save({ session })) || user;
        } catch (err: unknown) {
          if (AuthService.isDuplicateKeyError(err)) {
            throw new ConflictException("Email already exists");
          }
          throw err;
        }

        const tokenHash = this.hashToken(rawVerificationToken);
        const expiresAt = new Date(
          Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS
        );

        await this.emailVerificationTokenModel.create(
          [{ userId: createdUser._id, tokenHash, expiresAt }],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    this.userEventsService.emitUserRegistered(createdUser);
    this.userEventsService.emitEmailVerificationRequested(
      createdUser.email,
      rawVerificationToken,
      createdUser.fullName
    );

    const source = hasToObject(createdUser)
      ? (createdUser.toObject() as AuthUserSource)
      : (createdUser as AuthUserSource);
    const profile = this.toAuthUserProfile(source);
    if (!profile) {
      throw new ServiceUnavailableException("Created user profile is invalid");
    }
    return profile;
  }

  async verifyEmail(data: VerifyEmailDto): Promise<AuthMessageResult> {
    const tokenHash = this.hashToken(data.token);

    const session = await this.emailVerificationTokenModel.db.startSession();
    let verifiedUserId: string | undefined;

    try {
      await session.withTransaction(async () => {
        const verificationToken =
          await this.emailVerificationTokenModel.findOneAndUpdate(
            { tokenHash, isUsed: false, expiresAt: { $gt: new Date() } },
            { isUsed: true },
            { session }
          );

        if (!verificationToken) {
          const existing = await this.emailVerificationTokenModel
            .findOne({ tokenHash })
            .session(session);
          if (!existing) {
            throw new BadRequestException(
              "Invalid or expired verification token"
            );
          }
          if (existing.isUsed) {
            throw new BadRequestException(
              "Verification token has already been used"
            );
          }
          throw new BadRequestException("Verification token has expired");
        }

        const user = await this.userModel.findByIdAndUpdate(
          verificationToken.userId,
          { isVerified: true },
          { new: true, session }
        );
        if (!user) {
          throw new NotFoundException("User not found");
        }

        verifiedUserId = user._id.toString();
      });
    } finally {
      await session.endSession();
    }

    await this.invalidateUserCache(verifiedUserId!);
    this.logger.info(`auth.email_verified — userId=${verifiedUserId}`);

    return this.authMessage("Email verified successfully.");
  }

  async resendVerificationEmail(email: string): Promise<AuthMessageResult> {
    const genericResponse = this.authMessage(
      "If that email address is registered and not yet verified, we have sent a new verification link to it."
    );

    const user = await this.userModel.findOne({ email });
    if (!user || user.isVerified) {
      return genericResponse;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);

    const session = await this.emailVerificationTokenModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.emailVerificationTokenModel.deleteMany(
          { userId: user._id },
          { session }
        );
        await this.emailVerificationTokenModel.create(
          [{ userId: user._id, tokenHash, expiresAt }],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    this.userEventsService.emitEmailVerificationRequested(
      user.email,
      rawToken,
      user.fullName
    );

    return genericResponse;
  }

  async login(
    data: LoginDTO,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<LoginResult> {
    const { email, password } = data;
    const ip = meta.ipAddress || "unknown";
    const user = await this.withPassword(this.userModel.findOne({ email }));

    if (!user) {
      await this.loginAttemptService.recordFailedAttempt(email, ip);
      throw new UnauthorizedException("Invalid credentials");
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      await this.loginAttemptService.recordFailedAttempt(email, ip);
      throw new UnauthorizedException("Invalid credentials");
    }

    // Login đúng → reset count
    await this.loginAttemptService.resetLocked(email, ip);

    if (user.twoFactorEnabled) {
      const twoFactorToken = await this.createTwoFactorPendingLogin(
        user._id.toString()
      );
      return this.twoFactorRequired(twoFactorToken);
    }

    // Tạo token + session mới (không đụng session của thiết bị khác)
    const tokens = await this.generateUserTokens(user._id, meta);

    this.setTokenCookies(res, tokens);
    return this.authMessage("Logged in successfully");
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

  /** Completes a password-verified login that was paused for 2FA — consumes the pending token, checks OTP/recovery code, then issues session cookies exactly like a normal login. */
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
    // GETDEL atomically fetches-and-removes the key, so two concurrent requests for the
    // same token can never both get a userId back — only one can ever complete the login.
    // Trade-off: a wrong OTP also burns the pending token (no multi-attempt retry window);
    // the user must re-submit the password to get a fresh token. This is intentional —
    // a non-atomic get-then-verify-then-delete would let concurrent requests both pass.
    const userId = await this.redisService.client.getDel(pendingKey);
    if (!userId) {
      throw new UnauthorizedException("Invalid or expired login session");
    }

    const isValidOtp = await this.twoFactorService.verifyLoginOtp(userId, otp);
    if (!isValidOtp) {
      throw new UnauthorizedException("Invalid OTP or recovery code");
    }

    const tokens = await this.generateUserTokens(userId, meta);
    this.setTokenCookies(res, tokens);
    return this.authMessage("Logged in successfully");
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
    return this.generateUserTokens(user!._id, meta);
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
    this.setTokenCookies(res, tokens);

    const frontendBaseUrl = envConfig.FRONTEND_URL?.replace(/\/+$/, "");
    const redirectTarget = frontendBaseUrl ? `${frontendBaseUrl}/` : "/";

    res.redirect(redirectTarget);
  }

  status(): AuthMessageResult {
    return this.authMessage("Logged in successfully");
  }

  getCurrentUser(req: Request): CurrentUserResult {
    return req.currentUser;
  }

  private readonly USER_CACHE_TTL_SEC = 300;

  async getUserById(id: string): Promise<AuthUserProfile | null> {
    const cacheKey = this.generateCacheKeyForUser(id);
    const raw = await this.redisService.client.get(cacheKey).catch(() => null);
    let user: AuthUserSource | null = raw
      ? (JSON.parse(raw) as AuthUserSource)
      : null;
    if (!user) {
      user = await this.userModel
        .findById(id)
        .select(
          "email fullName phoneNumber role isVerified isActive twoFactorEnabled avatarPublicId createdAt updatedAt"
        )
        .lean<AuthUserSource>();
      if (!user) return null;
      await this.redisService.client
        .set(cacheKey, JSON.stringify(user), { EX: this.USER_CACHE_TTL_SEC })
        .catch(() => {});
    }
    return this.toAuthUserProfile(user);
  }

  async refreshToken(
    refreshToken: string,
    meta: SessionRequestMeta,
    res: Response
  ): Promise<AuthMessageResult> {
    if (!refreshToken) {
      throw new BadRequestException("Refresh token is required");
    }

    if (!UUID_V4_REGEX.test(refreshToken)) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const tokenHash = this.hashToken(refreshToken);
    const session = await this.sessionModel.findOne({
      refreshTokenHash: tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
      // Check shadow: token was consumed recently by a rotation → possible token theft
      const shadowKey = this.getSessionShadowKey(tokenHash);
      const shadowUserId = await this.redisService.client.get(shadowKey);
      if (shadowUserId) {
        this.logger.warn(
          `SECURITY: Refresh token reuse detected for userId=${shadowUserId}. Revoking all sessions.`
        );
        await this.revokeAllUserSessions(shadowUserId);
        await this.redisService.client.del(shadowKey);
      }
      throw new UnauthorizedException("Invalid refresh token");
    }

    const user = await this.getActiveUserOrThrow(session.userId);
    const accessToken = this.issueAccessToken(user);

    const newRefreshToken = uuidv4();
    const newHash = this.hashToken(newRefreshToken);
    const sanitizedUserAgent = sanitizeUserAgent(meta.userAgent);

    // Atomic conditional swap: only succeeds if this exact hash is still the live one,
    // so two concurrent refresh calls with the same token can never both succeed.
    const rotated = await this.sessionModel.findOneAndUpdate(
      {
        _id: session._id,
        refreshTokenHash: tokenHash,
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          refreshTokenHash: newHash,
          lastUsedAt: new Date(),
          expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
          ...(meta.ipAddress ? { ipAddress: meta.ipAddress } : {}),
          ...(sanitizedUserAgent
            ? {
                userAgent: sanitizedUserAgent,
                deviceInfo: parseDeviceInfo(sanitizedUserAgent),
              }
            : {}),
        },
      }
    );

    if (!rotated) {
      // Lost the race to a concurrent refresh using the same token.
      throw new UnauthorizedException("Invalid refresh token");
    }

    // Short-lived marker of the just-rotated hash, used only to detect replay of a stale token.
    await this.redisService.client
      .set(this.getSessionShadowKey(tokenHash), user._id.toString(), {
        EX: SHADOW_TTL_SECONDS,
      })
      .catch(() => {});

    this.setTokenCookies(res, { accessToken, refreshToken: newRefreshToken });
    return this.authMessage("Token refreshed successfully");
  }

  private async blacklistAccessTokenFromRequest(req: Request): Promise<void> {
    const accessToken = req.cookies?.access_token;
    if (!accessToken) return;

    let decoded: { exp?: number } | null = null;
    try {
      decoded = this.jwtService.verify(accessToken) as {
        exp?: number;
      } | null;
    } catch {
      this.logger.warn(
        "logout: access token verification failed, skipping blacklist"
      );
      return;
    }

    if (!decoded) return;

    const now = Math.floor(Date.now() / 1000);
    const remaining = decoded.exp && decoded.exp > now ? decoded.exp - now : 0;
    const ttl = Math.min(remaining, ACCESS_TOKEN_TTL_SECONDS);

    if (ttl <= 0) return;

    try {
      await this.redisService.client.set(
        `blacklist:access:${accessToken}`,
        "1",
        { EX: ttl }
      );
    } catch (redisErr) {
      this.logger.error(
        `logout: Redis unavailable, cannot blacklist token — ${(redisErr as Error)?.message ?? "unknown"}`
      );
      throw new ServiceUnavailableException(
        "Logout failed: unable to invalidate session. Please try again or wait for the token to expire."
      );
    }
  }

  /** Logs out the current device only — other sessions the user has elsewhere stay active. */
  async logout(
    refreshToken: string | undefined,
    res: Response,
    req: Request
  ): Promise<AuthMessageResult> {
    this.clearTokenCookies(res);
    await this.blacklistAccessTokenFromRequest(req);

    if (!refreshToken || !UUID_V4_REGEX.test(refreshToken)) {
      return this.authMessage("Logged out successfully");
    }

    const tokenHash = this.hashToken(refreshToken);
    const session = await this.sessionModel.findOneAndUpdate(
      { refreshTokenHash: tokenHash, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    if (session) {
      await this.invalidateUserCache(session.userId.toString());
    }

    return this.authMessage("Logged out successfully");
  }

  /** Revokes every session the user has (all devices) and clears the caller's own cookies. */
  async logoutAll(
    userId: string,
    res: Response,
    req: Request
  ): Promise<AuthMessageResult> {
    this.clearTokenCookies(res);
    await this.blacklistAccessTokenFromRequest(req);
    await this.revokeAllUserSessions(userId);
    await this.invalidateUserCache(userId);
    this.logger.info(`auth.logout_all — userId=${userId}`);
    return this.authMessage("Logged out from all devices successfully");
  }

  /** Lists the caller's active (non-revoked, non-expired) sessions — never exposes the token hash itself. */
  async getSessions(
    userId: string,
    currentRawToken?: string
  ): Promise<SessionSummary[]> {
    const currentHash = currentRawToken
      ? this.hashToken(currentRawToken)
      : undefined;

    const sessions = await this.sessionModel
      .find({ userId, revokedAt: null, expiresAt: { $gt: new Date() } })
      .sort({ lastUsedAt: -1 })
      .lean<SessionLean[]>();

    return sessions.map((session) => ({
      id: session._id.toString(),
      deviceInfo: session.deviceInfo ?? null,
      ipAddress: session.ipAddress ?? null,
      lastUsedAt: session.lastUsedAt,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      isCurrent: currentHash ? session.refreshTokenHash === currentHash : false,
    }));
  }

  /** Revokes exactly one of the caller's own sessions — the userId filter makes this IDOR-safe. */
  async revokeSession(
    userId: string,
    sessionId: string
  ): Promise<AuthMessageResult> {
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new BadRequestException("Invalid session id");
    }

    const session = await this.sessionModel.findOneAndUpdate(
      { _id: sessionId, userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    if (!session) {
      throw new NotFoundException("Session not found or already revoked");
    }

    this.logger.info(
      `auth.session_revoked — userId=${userId} sessionId=${sessionId}`
    );
    return this.authMessage("Session revoked successfully");
  }

  async generateUserTokens(
    userId: string | Types.ObjectId,
    meta: SessionRequestMeta = {}
  ): Promise<AuthTokenPair> {
    const user = await this.getActiveUserOrThrow(userId);
    const accessToken = this.issueAccessToken(user);
    const refreshToken = await this.createSession(
      user._id as Types.ObjectId,
      meta
    );
    return this.authTokenPair(accessToken, refreshToken);
  }

  // changePassword
  async changePassword(
    userId: string,
    data: ChangePasswordDTO
  ): Promise<AuthMessageResult> {
    const { oldPassword, newPassword } = data;
    const user = await this.withPassword(this.userModel.findById(userId));
    if (!user) {
      throw new NotFoundException("User not found");
    }
    const isMatch = await user.comparePassword(oldPassword);
    if (!isMatch) {
      throw new UnauthorizedException("Invalid old password");
    }
    user.password = newPassword;
    await user.save();
    await Promise.all([
      this.revokeAllUserSessions(userId),
      this.invalidateUserCache(userId),
    ]);
    return this.authMessage("Password changed successfully");
  }

  async forgotPassword(email: string): Promise<AuthMessageResult> {
    const genericResponse = this.authMessage(
      "If that email address is in our system, we have sent a password reset link to it."
    );

    const user = await this.userModel.findOne({ email });
    if (!user) {
      return genericResponse;
    }

    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + 3600000); // 1 hour

    const session = await this.resetTokenModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.resetTokenModel.deleteMany(
          { userId: user._id, isUsed: false },
          { session }
        );
        await this.resetTokenModel.create(
          [{ userId: user._id, token: resetToken, expiresAt, isUsed: false }],
          { session }
        );
      });
    } finally {
      session.endSession();
    }

    this.userEventsService.emitPasswordResetRequested(
      user.email,
      resetToken,
      user.fullName
    );
    return genericResponse;
  }

  async resetPassword(data: ResetPasswordDto): Promise<AuthMessageResult> {
    const { resetToken, newPassword, confirmPassword } = data;

    if (newPassword !== confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }

    if (!UUID_V4_REGEX.test(resetToken)) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    const token = await this.resetTokenModel.findOneAndUpdate(
      {
        token: resetToken,
        isUsed: false,
        expiresAt: { $gt: new Date() },
      },
      { isUsed: true }
    );
    if (!token) {
      const existing = await this.resetTokenModel.findOne({
        token: resetToken,
      });
      if (!existing) {
        throw new BadRequestException("Invalid or expired reset token");
      }
      if (existing.isUsed) {
        throw new BadRequestException("Reset token has already been used");
      }
      throw new BadRequestException("Reset token has expired");
    }
    const user = await this.userModel.findById(token.userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    user.password = newPassword;
    await user.save();
    await this.revokeAllUserSessions(user._id.toString());
    await this.invalidateUserCache(user.id.toString());
    return this.authMessage(
      "Password has been reset successfully. Please login again."
    );
  }
}
