import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { PassportStrategy } from "@nestjs/passport";
import { User } from "@src/schemas/user.schema";
import { RedisService } from "@src/redis/redis.service";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Request } from "express";
import { Model } from "mongoose";
import { getErrorMessage } from "@src/helper/getErrorMessage";

type JwtClaims = {
  userId: string;
  role: string;
};

type ValidatedJwtPayload = JwtClaims & {
  isVerified: boolean;
};

type CachedUserState = {
  isActive: boolean;
  role: string;
  isVerified: boolean;
};

const AUTH_USER_CACHE_TTL_SEC = 60;

const extractAccessTokenFromCookie = (request: Request): string | null => {
  const cookies = request.cookies as
    Record<string, string | undefined> | undefined;
  return cookies?.access_token ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly logger = new Logger(JwtStrategy.name);

  constructor(
    private readonly config: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly redisService: RedisService
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractAccessTokenFromCookie]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("SECRET_KEY"),
      algorithms: ["HS256"],
      passReqToCallback: true,
    });
  }

  async validate(
    request: Request,
    payload: JwtClaims
  ): Promise<ValidatedJwtPayload> {
    if (!payload?.userId) {
      throw new UnauthorizedException("Invalid token payload");
    }

    const token = extractAccessTokenFromCookie(request);

    if (token) {
      try {
        const isBlacklisted = await this.redisService.client.get(
          `blacklist:access:${token}`
        );
        if (isBlacklisted) {
          throw new UnauthorizedException("Token has been revoked");
        }
      } catch (err) {
        if (err instanceof UnauthorizedException) throw err;
        throw new UnauthorizedException("Auth service temporarily unavailable");
      }
    }

    const cacheKey = `auth:user-state:${payload.userId}`;
    let userState: CachedUserState | null = null;

    try {
      const raw = await this.redisService.client.get(cacheKey);
      if (raw) {
        userState = JSON.parse(raw) as CachedUserState;
      }
    } catch (error) {
      this.logger.warn(
        `JwtStrategy: auth state cache read failed for userId=${payload.userId}: ${getErrorMessage(error)}`
      );
    }

    if (!userState) {
      const user = await this.userModel
        .findById(payload.userId)
        .select("_id role isActive isVerified")
        .lean();

      if (!user || user.isActive === false) {
        throw new UnauthorizedException("User not found or inactive");
      }

      userState = {
        isActive: user.isActive,
        role: user.role,
        isVerified: user.isVerified,
      };

      try {
        await this.redisService.client.set(
          cacheKey,
          JSON.stringify(userState),
          { EX: AUTH_USER_CACHE_TTL_SEC }
        );
      } catch (error) {
        this.logger.warn(
          `JwtStrategy: auth state cache write failed for userId=${payload.userId}: ${getErrorMessage(error)}`
        );
      }
    } else if (!userState.isActive) {
      throw new UnauthorizedException("User not found or inactive");
    }

    return {
      ...payload,
      role: userState.role,
      isVerified: userState.isVerified,
    };
  }
}
