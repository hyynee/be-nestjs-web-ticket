import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class RedisRateLimitExampleService {
  constructor(private readonly redisService: RedisService) {}

  async isAllowed(key: string, limit = 10, windowSec = 60): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const windowKey = `ratelimit:${key}:${Math.floor(now / windowSec)}`;
    const count = await this.redisService.client.incr(windowKey);
    if (count === 1) {
      await this.redisService.client.expire(windowKey, windowSec);
    }
    return count <= limit;
  }
}
