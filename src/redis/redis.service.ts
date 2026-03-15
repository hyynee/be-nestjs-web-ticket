import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisClientType, createClient } from 'redis';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: RedisClientType;

  constructor(private readonly configService: ConfigService) {
    const host =
      this.configService.get<string>('REDIS_HOST') ||
      this.configService.get<string>('redis.host') ||
      'localhost';
    const parsedPort = Number(
      this.configService.get<string>('REDIS_PORT') ||
        this.configService.get<number>('redis.port') ||
        6379,
    );
    const port = Number.isNaN(parsedPort) ? 6379 : parsedPort;
    const password = this.configService.get<string>('REDIS_PASSWORD') || undefined;
    const parsedDatabase = Number(this.configService.get<string>('REDIS_DB') || 0);
    const database = Number.isNaN(parsedDatabase) ? 0 : parsedDatabase;

    this.client = createClient({
      socket: {
        host,
        port,
      },
      password,
      database,
    });

    this.client.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('[Redis] error', err?.message || err);
    });

    this.client.connect().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[Redis] connect failed', err?.message || err);
    });
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }
}