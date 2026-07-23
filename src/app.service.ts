import { Injectable } from "@nestjs/common";
import * as os from "os";

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

@Injectable()
export class AppService {
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
}
