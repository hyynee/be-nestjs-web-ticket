import { Injectable } from "@nestjs/common";
import { InjectConnection } from "@nestjs/mongoose";
import type { Connection } from "mongoose";
import * as os from "os";
import { RedisService } from "./redis/redis.service";
import { QueueService } from "./queue/queue.service";

@Injectable()
export class AppService {
  constructor(
    @InjectConnection() private readonly mongoConnection: Connection,
    private readonly redisService: RedisService,
    private readonly queueService: QueueService
  ) {}

  getHealth() {
    return { status: "ok" };
  }

  getInternalMetrics() {
    const mem = process.memoryUsage();
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
        loadAvg: os.loadavg().map((v) => Math.round(v * 100) / 100),
      },
      version: process.env.npm_package_version ?? "unknown",
    };
  }

  async getReadiness() {
    try {
      const mongoReady = this.mongoConnection.readyState === 1; // 1 = connected
      const redisReady = Boolean(this.redisService?.client?.isOpen);

      let queueCounts: Record<string, number> = {};
      try {
        queueCounts = await this.queueService.getJobCounts();
      } catch {
        // Queue metrics are informational — don't fail readiness for them
      }

      const ready = mongoReady && redisReady;

      return {
        status: ready ? "ready" : "not_ready",
        dependencies: {
          mongodb: mongoReady ? "up" : "down",
          redis: redisReady ? "up" : "down",
        },
        queue: {
          active: queueCounts.active ?? 0,
          waiting: queueCounts.waiting ?? 0,
          failed: queueCounts.failed ?? 0,
          delayed: queueCounts.delayed ?? 0,
        },
      };
    } catch {
      return {
        status: "not_ready",
        dependencies: { mongodb: "down", redis: "down" },
        queue: {},
      };
    }
  }
}
