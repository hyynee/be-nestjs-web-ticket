import { Injectable, Logger } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import * as os from "os";
import { RedisService } from "./redis/redis.service";
import { QueueService } from "./queue/queue.service";
import { getErrorMessage } from "./helper/getErrorMessage";

export interface HealthResponse {
  status: "ok";
}

export interface InternalMetricsResponse {
  status: "ok";
  uptime: number;
  memory: Record<"heapUsedMb" | "heapTotalMb" | "rssMb" | "externalMb", number>;
  os: {
    freeMb: number;
    totalMb: number;
    loadAvg: number[];
  };
  version: string;
}

export interface ReadinessResponse {
  status: "ready" | "not_ready";
  dependencies: Record<"mongodb" | "redis", "up" | "down">;
  queue: Record<"active" | "waiting" | "failed" | "delayed", number>;
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly redisService: RedisService,
    private readonly queueService: QueueService
  ) {}

  private health(): HealthResponse {
    return { status: "ok" };
  }

  private internalMetrics(
    mem: NodeJS.MemoryUsage,
    loadAvg: number[]
  ): InternalMetricsResponse {
    return {
      status: "ok",
      uptime: Math.floor(process.uptime()),
      memory: {
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
        heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
        rssMb: Math.round(mem.rss / 1024 / 1024),
        externalMb: Math.round(mem.external / 1024 / 1024),
      },
      os: {
        freeMb: Math.round(os.freemem() / 1024 / 1024),
        totalMb: Math.round(os.totalmem() / 1024 / 1024),
        loadAvg,
      },
      version: process.env.npm_package_version ?? "unknown",
    };
  }

  private readiness(input: {
    mongoReady: boolean;
    redisReady: boolean;
    queueCounts: Record<string, number>;
  }): ReadinessResponse {
    const ready = input.mongoReady && input.redisReady;
    return {
      status: ready ? "ready" : "not_ready",
      dependencies: {
        mongodb: input.mongoReady ? "up" : "down",
        redis: input.redisReady ? "up" : "down",
      },
      queue: {
        active: input.queueCounts.active ?? 0,
        waiting: input.queueCounts.waiting ?? 0,
        failed: input.queueCounts.failed ?? 0,
        delayed: input.queueCounts.delayed ?? 0,
      },
    };
  }

  private unavailableReadiness(): ReadinessResponse {
    return {
      status: "not_ready",
      dependencies: { mongodb: "down", redis: "down" },
      queue: {
        active: 0,
        waiting: 0,
        failed: 0,
        delayed: 0,
      },
    };
  }

  getHealth(): HealthResponse {
    return this.health();
  }

  getInternalMetrics(): InternalMetricsResponse {
    const mem = process.memoryUsage();
    return this.internalMetrics(
      mem,
      os.loadavg().map((v) => Math.round(v * 100) / 100)
    );
  }

  async getReadiness(): Promise<ReadinessResponse> {
    try {
      const mongoReady = this.mongoConnection.readyState === 1; // 1 = connected
      const redisReady = Boolean(this.redisService?.client?.isOpen);

      let queueCounts: Record<string, number> = {};
      try {
        queueCounts = await this.queueService.getJobCounts();
      } catch (error) {
        this.logger.warn(
          `Readiness queue metrics unavailable: ${getErrorMessage(error)}`
        );
      }

      return this.readiness({ mongoReady, redisReady, queueCounts });
    } catch (error) {
      this.logger.warn(`Readiness check failed: ${getErrorMessage(error)}`);
      return this.unavailableReadiness();
    }
  }
}
