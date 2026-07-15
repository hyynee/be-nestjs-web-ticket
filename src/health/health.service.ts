import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { RedisService } from "@src/redis/redis.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";

export type DependencyCheckStatus = "ok" | "failed";

export interface ReadinessChecks {
  mongo: DependencyCheckStatus;
  redis: DependencyCheckStatus;
  queue: DependencyCheckStatus;
  config: DependencyCheckStatus;
}

export interface ReadinessResult {
  status: "ready" | "unavailable";
  checks: ReadinessChecks;
}

const CHECK_TIMEOUT_MS = 3000;

/** Env vars required for critical integrations — presence checked, values never returned. */
const REQUIRED_CONFIG_KEYS = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PAYPAL_CLIENT_ID",
  "PAYPAL_CLIENT_SECRET",
  "SMTP_HOST",
  "SMTP_USER",
] as const;

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} check timed out after ${ms}ms`)),
      ms
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

@Injectable()
export class HealthService {
  private readonly logger = new Logger(HealthService.name);

  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly redisService: RedisService,
    @InjectQueue("default") private readonly queue: Queue,
    private readonly configService: ConfigService
  ) {}

  async checkReadiness(): Promise<ReadinessResult> {
    const [mongo, redis, queue, config] = await Promise.all([
      this.checkMongo(),
      this.checkRedis(),
      this.checkQueue(),
      this.checkConfig(),
    ]);

    const checks: ReadinessChecks = { mongo, redis, queue, config };
    const status = Object.values(checks).every((c) => c === "ok")
      ? "ready"
      : "unavailable";

    return { status, checks };
  }

  private async checkMongo(): Promise<DependencyCheckStatus> {
    try {
      if (this.mongoConnection.readyState !== 1) {
        return "failed";
      }
      const db = this.mongoConnection.db;
      if (!db) {
        return "failed";
      }
      await withTimeout(db.command({ ping: 1 }), CHECK_TIMEOUT_MS, "Mongo");
      return "ok";
    } catch (err) {
      this.logger.warn(`Mongo readiness check failed: ${getErrorMessage(err)}`);
      return "failed";
    }
  }

  private async checkRedis(): Promise<DependencyCheckStatus> {
    try {
      await withTimeout(
        this.redisService.client.ping(),
        CHECK_TIMEOUT_MS,
        "Redis"
      );
      return "ok";
    } catch (err) {
      this.logger.warn(`Redis readiness check failed: ${getErrorMessage(err)}`);
      return "failed";
    }
  }

  private async checkQueue(): Promise<DependencyCheckStatus> {
    try {
      const client = await withTimeout(
        this.queue.client,
        CHECK_TIMEOUT_MS,
        "Queue"
      );
      await withTimeout(client.info(), CHECK_TIMEOUT_MS, "Queue");
      return "ok";
    } catch (err) {
      this.logger.warn(`Queue readiness check failed: ${getErrorMessage(err)}`);
      return "failed";
    }
  }

  private checkConfig(): DependencyCheckStatus {
    const missing = REQUIRED_CONFIG_KEYS.filter(
      (key) => !this.configService.get<string>(key)
    );

    if (missing.length > 0) {
      this.logger.warn(
        `Config readiness check failed — missing keys: ${missing.join(", ")}`
      );
      return "failed";
    }

    return "ok";
  }
}
