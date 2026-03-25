import { Injectable } from '@nestjs/common';
import { RedisService } from './redis.service';

@Injectable()
export class RedisPubSubExampleService {
  constructor(private readonly redisService: RedisService) {}

  async publish(channel: string, message: string) {
    await this.redisService.client.publish(channel, message);
  }

  async subscribe(channel: string, onMessage: (msg: string) => void) {
    const subscriber = this.redisService.client.duplicate();
    await subscriber.connect();
    await subscriber.subscribe(channel, (message) => {
      onMessage(message);
    });
    // Return unsubscribe function
    return async () => {
      await subscriber.unsubscribe(channel);
      await subscriber.quit();
    };
  }
}
