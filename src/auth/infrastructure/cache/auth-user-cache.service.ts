import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";
import { AuthUserSource } from "../../domain/types/auth.types";
import { getErrorMessage } from "@src/helper/getErrorMessage";

const AUTH_USER_RESPONSE_SCHEMA_VERSION = "v1";
const USER_CACHE_TTL_SEC = 300;

@Injectable()
export class AuthUserCacheService {
  private readonly logger = new Logger(AuthUserCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  userDetailsKey(userId: string): string {
    return `user:details:${AUTH_USER_RESPONSE_SCHEMA_VERSION}:${userId}`;
  }

  userStateKey(userId: string): string {
    return `auth:user-state:${userId}`;
  }

  async invalidateUser(userId: string): Promise<void> {
    await Promise.all([
      this.redisService.client
        .del(this.userDetailsKey(userId))
        .catch((error: unknown) => {
          this.logger.warn(
            `AuthUserCacheService: user details cache invalidation failed for userId=${userId}: ${getErrorMessage(error)}`
          );
        }),
      this.redisService.client
        .del(this.userStateKey(userId))
        .catch((error: unknown) => {
          this.logger.warn(
            `AuthUserCacheService: user state cache invalidation failed for userId=${userId}: ${getErrorMessage(error)}`
          );
        }),
    ]);
  }

  async getUserDetails(userId: string): Promise<AuthUserSource | null> {
    const raw = await this.redisService.client
      .get(this.userDetailsKey(userId))
      .catch((error: unknown) => {
        this.logger.warn(
          `AuthUserCacheService: user details cache read failed for userId=${userId}: ${getErrorMessage(error)}`
        );
        return null;
      });
    return raw ? (JSON.parse(raw) as AuthUserSource) : null;
  }

  async setUserDetails(userId: string, user: AuthUserSource): Promise<void> {
    await this.redisService.client
      .set(this.userDetailsKey(userId), JSON.stringify(user), {
        EX: USER_CACHE_TTL_SEC,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `AuthUserCacheService: user details cache write failed for userId=${userId}: ${getErrorMessage(error)}`
        );
      });
  }
}
