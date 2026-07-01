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
import { ChangePasswordDTO } from "./dto/password.dto";
import envConfig from "@src/config/config";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { MailService } from "@src/services/mail.service";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ResetToken } from "@src/schemas/reset-token.schema";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { UserEventsService } from "@src/events/user-event.services";
import { v2 as cloudinary } from "cloudinary";
import { RedisService } from "@src/redis/redis.service";
import { CookieOptions, Response, Request } from "express";
import {
  ACCESS_TOKEN_TTL_MS,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_SECONDS,
  SHADOW_TTL_SECONDS,
} from "./auth.constants";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";

type GoogleProfile = {
  email?: string;
  name?: string;
  picture?: string;
};

@Injectable()
export class AuthService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(ResetToken.name)
    private readonly resetTokenModel: Model<ResetToken>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,

    private jwtService: JwtService,
    private loginAttemptService: LockLoginService,
    private readonly userEventsService: UserEventsService,
    private mailService: MailService,
    private readonly redisService: RedisService
  ) {}
  private generateCacheKeyForUser(userId: string): string {
    return `user:details:${userId}`;
  }
  private async invalidateUserCache(userId: string): Promise<void> {
    const cacheKey = this.generateCacheKeyForUser(userId);
    await Promise.all([
      this.redisService.client.del(cacheKey).catch(() => {}),
      this.redisService.client.del(`auth:user-state:${userId}`).catch(() => {}),
    ]);
  }

  private getRefreshTokenKey(token: string): string {
    return `auth:refresh:${token}`;
  }

  private getUserRefreshTokenSetKey(userId: string): string {
    return `auth:user:${userId}:refresh-tokens`;
  }

  private withPassword(query: any) {
    if (query && typeof query.select === "function") {
      return query.select("+password");
    }
    return query;
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

  private async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    const userTokenSetKey = this.getUserRefreshTokenSetKey(userId);
    const tokens = await this.redisService.client.sMembers(userTokenSetKey);

    const multi = this.redisService.client.multi();
    for (const token of tokens) {
      multi.del(this.getRefreshTokenKey(token));
    }
    multi.del(userTokenSetKey);

    await multi.exec();
  }

  private static isDuplicateKeyError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false;
    const code = (err as Record<string, unknown>).code;
    return code === 11000 || code === 11001;
  }

  async register(data: RegisterDTO): Promise<Record<string, unknown>> {
    const { email, password, confirmPassword, fullName } = data;
    if (password !== confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }
    const user = new this.userModel({
      email,
      password,
      fullName,
      role: "user",
    });
    let createdUser: typeof user;
    try {
      createdUser = (await user.save()) || user;
    } catch (err: unknown) {
      if (AuthService.isDuplicateKeyError(err)) {
        throw new ConflictException("Email already exists");
      }
      throw err;
    }
    this.userEventsService.emitUserRegistered(createdUser);

    if (typeof (createdUser as any).toObject !== "function") {
      return createdUser as unknown as Record<string, unknown>;
    }

    const createdUserObject = (createdUser as any).toObject() as Record<
      string,
      unknown
    >;
    const { password: _password, ...sanitizedUser } = createdUserObject;
    void _password;
    return sanitizedUser;
  }

  async login(data: LoginDTO, ip: string, res: Response) {
    const { email, password } = data;
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
    // Tạo token
    const tokens = await this.generateUserTokens(user._id);

    this.setTokenCookies(res, tokens);
    return { message: "Logged in successfully" };
  }

  async loginWithGoogle(profile: GoogleProfile) {
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
    return this.generateUserTokens(user!._id);
  }

  async handleGoogleLoginCallback(
    profile: GoogleProfile | undefined,
    res: Response
  ) {
    if (!profile) {
      throw new BadRequestException(
        "Invalid Google profile: profile is required"
      );
    }

    const tokens = await this.loginWithGoogle(profile);
    this.setTokenCookies(res, tokens);

    const frontendBaseUrl = envConfig.FRONTEND_URL?.replace(/\/+$/, "");
    const redirectTarget = frontendBaseUrl ? `${frontendBaseUrl}/` : "/";

    res.redirect(redirectTarget);
  }

  status() {
    return { message: "Logged in successfully" };
  }

  getCurrentUser(req: any) {
    return req.currentUser;
  }

  private readonly USER_CACHE_TTL_SEC = 300;

  async getUserById(id: string) {
    const cacheKey = this.generateCacheKeyForUser(id);
    const raw = await this.redisService.client.get(cacheKey).catch(() => null);
    let user: User | null = raw ? (JSON.parse(raw) as User) : null;
    if (!user) {
      user = await this.userModel.findById(id).select("-password").lean<User>();
      if (!user) return null;
      await this.redisService.client
        .set(cacheKey, JSON.stringify(user), { EX: this.USER_CACHE_TTL_SEC })
        .catch(() => {});
    }
    const avatarUrl = user.avatarPublicId
      ? cloudinary.url(user.avatarPublicId, {
          type: "private",
          sign_url: true,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          secure: true,
        })
      : null;
    const { avatarPublicId, ...profile } = user;
    void avatarPublicId;
    return {
      ...profile,
      avatarUrl,
    };
  }

  async refreshToken(refreshToken: string, res: Response) {
    if (!refreshToken) {
      throw new BadRequestException("Refresh token is required");
    }

    if (!UUID_V4_REGEX.test(refreshToken)) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    const refreshTokenKey = this.getRefreshTokenKey(refreshToken);
    const userId = await this.redisService.client.get(refreshTokenKey);

    if (!userId) {
      // Check shadow: token was consumed recently → possible token theft
      const shadowKey = `auth:shadow:${refreshToken}`;
      const shadowUserId = await this.redisService.client.get(shadowKey);
      if (shadowUserId) {
        this.logger.warn(
          `SECURITY: Refresh token reuse detected for userId=${shadowUserId}. Revoking all sessions.`
        );
        await this.revokeAllUserRefreshTokens(shadowUserId);
        await this.redisService.client.del(shadowKey);
      }
      throw new UnauthorizedException("Invalid refresh token");
    }

    const tokens = await this.generateUserTokens(userId);
    this.setTokenCookies(res, tokens);
    return { message: "Token refreshed successfully" };
  }

  async logout(refreshToken: string | undefined, res: Response, req: Request) {
    this.clearTokenCookies(res);

    const accessToken = req.cookies?.access_token;

    if (accessToken) {
      let decoded: { exp?: number } | null = null;
      try {
        decoded = this.jwtService.verify(accessToken) as {
          exp?: number;
        } | null;
      } catch {
        this.logger.warn(
          "logout: access token verification failed, skipping blacklist"
        );
      }

      if (decoded) {
        const now = Math.floor(Date.now() / 1000);
        const remaining =
          decoded.exp && decoded.exp > now ? decoded.exp - now : 0;
        const ttl = Math.min(remaining, ACCESS_TOKEN_TTL_SECONDS);

        if (ttl > 0) {
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
      }
    }

    if (!refreshToken || !UUID_V4_REGEX.test(refreshToken)) {
      return { message: "Logged out successfully" };
    }

    const userId = await this.redisService.client.get(
      this.getRefreshTokenKey(refreshToken)
    );

    if (userId) {
      await this.revokeAllUserRefreshTokens(userId);
      await this.invalidateUserCache(userId);
    }

    return { message: "Logged out successfully" };
  }

  async generateUserTokens(
    userId: string | Types.ObjectId
  ): Promise<{ accessToken: string; refreshToken: string }> {
    const normalizedUserId =
      typeof userId === "string" ? userId : userId.toString();

    const user = await this.userModel.findById(normalizedUserId);
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    if (!user.isActive) {
      throw new ForbiddenException("Account has been disabled");
    }

    const userIdString = user._id.toString();
    const accessToken = this.jwtService.sign(
      { userId: userIdString, role: user.role },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
    );
    const refreshToken = uuidv4();
    await this.rotateRefreshTokenAtomic(refreshToken, userIdString);
    return { accessToken, refreshToken };
  }

  private async rotateRefreshTokenAtomic(
    newToken: string,
    userId: string
  ): Promise<void> {
    const newTokenKey = this.getRefreshTokenKey(newToken);
    const setKey = this.getUserRefreshTokenSetKey(userId);
    const ttl = REFRESH_TOKEN_TTL_SECONDS;
    const shadowTtl = SHADOW_TTL_SECONDS;

    const lua = `
      local setKey     = KEYS[1]
      local newTokKey  = KEYS[2]
      local userId     = ARGV[1]
      local newTok     = ARGV[2]
      local ttl        = tonumber(ARGV[3])
      local prefix     = ARGV[4]
      local shadowPfx  = ARGV[5]
      local shadowTtl  = tonumber(ARGV[6])
      local stale      = redis.call('SMEMBERS', setKey)
      redis.call('SET', newTokKey, userId, 'EX', ttl)
      for _, t in ipairs(stale) do
        redis.call('DEL', prefix .. t)
        redis.call('SET', shadowPfx .. t, userId, 'EX', shadowTtl)
      end
      redis.call('DEL', setKey)
      redis.call('SADD', setKey, newTok)
      redis.call('EXPIRE', setKey, ttl)
      return 1
    `;

    await this.redisService.client.eval(lua, {
      keys: [setKey, newTokenKey],
      arguments: [
        userId,
        newToken,
        String(ttl),
        "auth:refresh:",
        "auth:shadow:",
        String(shadowTtl),
      ],
    });
  }

  // changePassword
  async changePassword(userId: string, data: ChangePasswordDTO) {
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
      this.revokeAllUserRefreshTokens(userId),
      this.invalidateUserCache(userId),
    ]);
    return { message: "Password changed successfully" };
  }

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.userModel.findOne({ email });
    if (!user) {
      return {
        message:
          "If that email address is in our system, we have sent a password reset link to it.",
      };
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
    return {
      message: "Password reset link has been sent to your email.",
    };
  }

  async resetPassword(data: ResetPasswordDto) {
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
    await this.revokeAllUserRefreshTokens(user._id.toString());
    await this.invalidateUserCache(user.id.toString());
    return {
      message: "Password has been reset successfully. Please login again.",
    };
  }
}
