import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class RedisCacheExampleService {
  constructor(private readonly redisService: RedisService) {}

  async setCache(key: string, value: any, ttl = 60) {
    await this.redisService.client.set(key, JSON.stringify(value), {
      EX: ttl,
    });
  }

  async getCache<T = any>(key: string): Promise<T | null> {
    const data = await this.redisService.client.get(key);
    return data ? (JSON.parse(data) as T) : null;
  }
}
