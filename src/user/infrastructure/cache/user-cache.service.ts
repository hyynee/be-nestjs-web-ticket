import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { Inject, Injectable } from "@nestjs/common";

const USER_RESPONSE_SCHEMA_VERSION = "v1";

@Injectable()
export class UserCacheService {
  constructor(@Inject(CACHE_MANAGER) private readonly cacheManager: Cache) {}

  deleteUserDetails(userId: string): Promise<boolean> {
    return this.cacheManager.del(this.userDetailsKey(userId));
  }

  private userDetailsKey(userId: string): string {
    return `user:details:${USER_RESPONSE_SCHEMA_VERSION}:${userId}`;
  }
}
