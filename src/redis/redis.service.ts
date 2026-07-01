import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { RedisClientType, createClient } from "redis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: RedisClientType;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.getOrThrow<string>("REDIS_HOST");
    const rawPort = this.configService.getOrThrow<string>("REDIS_PORT");
    const port = Number(rawPort);
    if (Number.isNaN(port)) {
      throw new Error("[Redis] REDIS_PORT must be a valid number");
    }

    const password = this.configService.get<string>("REDIS_PASSWORD");
    const rawDatabase = this.configService.get<string>("REDIS_DB");
    const database = rawDatabase ? Number(rawDatabase) : 0;
    if (Number.isNaN(database)) {
      throw new Error("[Redis] REDIS_DB must be a valid number");
    }

    const redisOptions: any = {
      socket: {
        host,
        port,
        reconnectStrategy: (retries: number) => {
          if (retries > 20) {
            this.logger.error(
              "[Redis] Max reconnection attempts reached — giving up"
            );
            return new Error("Max Redis reconnection attempts reached");
          }
          const delay = Math.min(retries * 100, 2000);
          this.logger.warn(
            `[Redis] reconnecting in ${delay}ms (attempt ${retries})`
          );
          return delay;
        },
        connectTimeout: 5000,
      },
      commandsQueueMaxLength: 5000,
      database,
    };
    if (password) {
      redisOptions.password = password;
    }
    this.client = createClient(redisOptions);

    this.client.on("error", (err) => {
      this.logger.error(`[Redis] error: ${getErrorMessage(err)}`);
    });
  }

  async onModuleInit() {
    try {
      await this.client.connect();
      this.logger.log("[Redis] connected successfully");
    } catch (err) {
      const isProduction =
        this.configService.get<string>("NODE_ENV") === "production";
      const message = `[Redis] connect failed: ${getErrorMessage(err)}`;
      this.logger.error(message);

      if (isProduction) {
        throw new Error(
          "[Redis] Startup aborted because Redis is unavailable in production"
        );
      }

      this.logger.warn(
        "[Redis] continuing startup because NODE_ENV is not production"
      );
    }
  }

  async onModuleDestroy() {
    if (this.client.isOpen) {
      await this.client.quit();
    }
  }

  async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = 0;
    do {
      const result = await this.client.scan(cursor, {
        MATCH: pattern,
        COUNT: 100,
      });
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (cursor !== 0);
    return keys;
  }
}
