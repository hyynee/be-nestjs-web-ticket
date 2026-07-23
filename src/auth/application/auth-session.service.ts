import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { Session } from "@src/schemas/session.schema";
import { RedisService } from "@src/redis/redis.service";
import { RedisSecurityService } from "@src/redis/redis-security.service";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";
import {
  parseDeviceInfo,
  sanitizeUserAgent,
} from "@src/common/utils/device.utils";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { Model, Types } from "mongoose";
import { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_MS,
  SHADOW_TTL_SECONDS,
} from "../auth.constants";
import {
  ActiveAuthUser,
  AuthMessageResult,
  AuthTokenPair,
  SessionLean,
  SessionRequestMeta,
  SessionSummary,
} from "../domain/types/auth.types";
import { AuthUserCacheService } from "../infrastructure/cache/auth-user-cache.service";
import { AuthCookieService } from "../infrastructure/http/auth-cookie.service";
import { AuthTokenService } from "../infrastructure/security/auth-token.service";
import { AuthPresenter } from "../presenters/auth.presenter";
import { getErrorMessage } from "@src/helper/getErrorMessage";

@Injectable()
export class AuthSessionService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Session.name) private readonly sessionModel: Model<Session>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly redisService: RedisService,
    private readonly redisSecurityService: RedisSecurityService,
    private readonly authUserCacheService: AuthUserCacheService,
    private readonly authCookieService: AuthCookieService,
    private readonly authTokenService: AuthTokenService,
    private readonly authPresenter: AuthPresenter
  ) {}

  private getSessionShadowKey(refreshTokenHash: string): string {
    return `auth:shadow:${refreshTokenHash}`;
  }

  private toSessionUserId(
    userId: string | Types.ObjectId
  ): string | Types.ObjectId {
    if (typeof userId === "string" && Types.ObjectId.isValid(userId)) {
      return new Types.ObjectId(userId);
    }
    return userId;
  }

  async revokeAllUserSessions(userId: string | Types.ObjectId): Promise<void> {
    await this.sessionModel.updateMany(
      { userId: this.toSessionUserId(userId), revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
  }

  async getActiveUserOrThrow(
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

  async createSession(
    userId: Types.ObjectId,
    meta: SessionRequestMeta
  ): Promise<string> {
    const rawRefreshToken = uuidv4();
    const sanitizedUserAgent = sanitizeUserAgent(meta.userAgent);

    await this.sessionModel.create({
      userId,
      refreshTokenHash: this.authTokenService.hashToken(rawRefreshToken),
      ipAddress: meta.ipAddress,
      userAgent: sanitizedUserAgent,
      deviceInfo: parseDeviceInfo(sanitizedUserAgent),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
    });

    return rawRefreshToken;
  }

  async generateUserTokens(
    userId: string | Types.ObjectId,
    meta: SessionRequestMeta = {}
  ): Promise<AuthTokenPair> {
    const user = await this.getActiveUserOrThrow(userId);
    const accessToken = this.authTokenService.issueAccessToken(user);
    const refreshToken = await this.createSession(
      user._id as Types.ObjectId,
      meta
    );
    return this.authPresenter.tokenPair(accessToken, refreshToken);
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

    const tokenHash = this.authTokenService.hashToken(refreshToken);
    const session = await this.sessionModel.findOne({
      refreshTokenHash: tokenHash,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
    });

    if (!session) {
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
    const accessToken = this.authTokenService.issueAccessToken(user);

    const newRefreshToken = uuidv4();
    const newHash = this.authTokenService.hashToken(newRefreshToken);
    const sanitizedUserAgent = sanitizeUserAgent(meta.userAgent);

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
      throw new UnauthorizedException("Invalid refresh token");
    }

    await this.redisService.client
      .set(this.getSessionShadowKey(tokenHash), user._id.toString(), {
        EX: SHADOW_TTL_SECONDS,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `refresh: failed to write session shadow cache for userId=${user._id.toString()} — ${getErrorMessage(error)}`
        );
      });

    this.authCookieService.setTokenCookies(res, {
      accessToken,
      refreshToken: newRefreshToken,
    });
    return this.authPresenter.message("Token refreshed successfully");
  }

  private async blacklistAccessTokenFromRequest(req: Request): Promise<void> {
    const accessToken = req.cookies?.access_token;
    if (!accessToken) return;

    let decoded: { exp?: number } | null = null;
    try {
      decoded = this.authTokenService.verifyAccessToken(accessToken) as {
        exp?: number;
      } | null;
    } catch (error) {
      this.logger.warn(
        `logout: access token verification failed, skipping blacklist — ${getErrorMessage(error)}`
      );
      return;
    }

    if (!decoded) return;

    const now = Math.floor(Date.now() / 1000);
    const remaining = decoded.exp && decoded.exp > now ? decoded.exp - now : 0;
    const ttl = Math.min(remaining, ACCESS_TOKEN_TTL_SECONDS);

    if (ttl <= 0) return;

    try {
      await this.redisSecurityService.client.set(
        `blacklist:access:${accessToken}`,
        "1",
        { EX: ttl }
      );
    } catch (redisErr) {
      this.logger.error(
        `logout: Redis unavailable, cannot blacklist token - ${(redisErr as Error)?.message ?? "unknown"}`
      );
      throw new ServiceUnavailableException(
        "Logout failed: unable to invalidate session. Please try again or wait for the token to expire."
      );
    }
  }

  async logout(
    refreshToken: string | undefined,
    res: Response,
    req: Request
  ): Promise<AuthMessageResult> {
    this.authCookieService.clearTokenCookies(res);
    await this.blacklistAccessTokenFromRequest(req);

    if (!refreshToken || !UUID_V4_REGEX.test(refreshToken)) {
      return this.authPresenter.message("Logged out successfully");
    }

    const tokenHash = this.authTokenService.hashToken(refreshToken);
    const session = await this.sessionModel.findOneAndUpdate(
      { refreshTokenHash: tokenHash, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );

    if (session) {
      await this.authUserCacheService.invalidateUser(session.userId.toString());
    }

    return this.authPresenter.message("Logged out successfully");
  }

  async logoutAll(
    userId: string,
    res: Response,
    req: Request
  ): Promise<AuthMessageResult> {
    this.authCookieService.clearTokenCookies(res);
    await this.blacklistAccessTokenFromRequest(req);
    await this.revokeAllUserSessions(userId);
    await this.authUserCacheService.invalidateUser(userId);
    this.logger.info(`auth.logout_all - userId=${userId}`);
    return this.authPresenter.message(
      "Logged out from all devices successfully"
    );
  }

  async getSessions(
    userId: string,
    currentRawToken?: string
  ): Promise<SessionSummary[]> {
    const currentHash = currentRawToken
      ? this.authTokenService.hashToken(currentRawToken)
      : undefined;

    const sessions = await this.sessionModel
      .find({
        userId: this.toSessionUserId(userId),
        revokedAt: null,
        expiresAt: { $gt: new Date() },
      })
      .sort({ lastUsedAt: -1 })
      .lean<SessionLean[]>();

    return sessions.map((session) =>
      this.authPresenter.toSessionSummary(session, currentHash)
    );
  }

  async revokeSession(
    userId: string,
    sessionId: string
  ): Promise<AuthMessageResult> {
    if (!Types.ObjectId.isValid(sessionId)) {
      throw new BadRequestException("Invalid session id");
    }

    const session = await this.sessionModel.findOneAndUpdate(
      {
        _id: sessionId,
        userId: this.toSessionUserId(userId),
        revokedAt: null,
      },
      { $set: { revokedAt: new Date() } }
    );

    if (!session) {
      throw new NotFoundException("Session not found or already revoked");
    }

    this.logger.info(
      `auth.session_revoked - userId=${userId} sessionId=${sessionId}`
    );
    return this.authPresenter.message("Session revoked successfully");
  }
}
