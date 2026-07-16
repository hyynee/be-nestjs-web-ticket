import { Injectable } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";
import { AuthUserSource } from "../../domain/types/auth.types";

const AUTH_USER_RESPONSE_SCHEMA_VERSION = "v1";
const USER_CACHE_TTL_SEC = 300;

@Injectable()
export class AuthUserCacheService {
  constructor(private readonly redisService: RedisService) {}

  userDetailsKey(userId: string): string {
    return `user:details:${AUTH_USER_RESPONSE_SCHEMA_VERSION}:${userId}`;
  }

  userStateKey(userId: string): string {
    return `auth:user-state:${userId}`;
  }

  async invalidateUser(userId: string): Promise<void> {
    await Promise.all([
      this.redisService.client.del(this.userDetailsKey(userId)).catch(() => {}),
      this.redisService.client.del(this.userStateKey(userId)).catch(() => {}),
    ]);
  }

  async getUserDetails(userId: string): Promise<AuthUserSource | null> {
    const raw = await this.redisService.client
      .get(this.userDetailsKey(userId))
      .catch(() => null);
    return raw ? (JSON.parse(raw) as AuthUserSource) : null;
  }

  async setUserDetails(userId: string, user: AuthUserSource): Promise<void> {
    await this.redisService.client
      .set(this.userDetailsKey(userId), JSON.stringify(user), {
        EX: USER_CACHE_TTL_SEC,
      })
      .catch(() => {});
  }
}
