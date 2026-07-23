import {
  Controller,
  Get,
  Headers,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Response } from "express";
import { ConfigService } from "@nestjs/config";
import { AppService } from "./app.service";
import { HealthService } from "./health/health.service";
import { MetricsService } from "./metrics/metrics.service";

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly healthService: HealthService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService
  ) {}

  @Get("health")
  health(): ReturnType<AppService["getHealth"]> {
    return this.appService.getHealth();
  }

  /**
   * Legacy alias for `GET /health/ready` — kept so existing monitoring/CD
   * config pointed at `/ready` doesn't 404, but delegates entirely to
   * `HealthService.checkReadiness()` instead of maintaining a second,
   * weaker readiness implementation (production-readiness-audit-2026-07-23.md:
   * `/ready` previously only checked Mongo `readyState`/Redis `.isOpen`
   * flags with no real ping, and CD trusted this weaker check). CD itself
   * now polls `/health/ready` directly — see `.github/workflows/cd.yml`.
   */
  @Get("ready")
  async ready(): ReturnType<HealthService["checkReadiness"]> {
    const readiness = await this.healthService.checkReadiness();
    if (readiness.status !== "ready") {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }

  @Get("internal/metrics")
  internalMetrics(
    @Headers("x-internal-secret") secret: string
  ): ReturnType<AppService["getInternalMetrics"]> {
    const expected = this.configService.get<string>("INTERNAL_METRICS_SECRET");
    if (!expected || secret !== expected) {
      throw new UnauthorizedException("Invalid internal secret");
    }
    return this.appService.getInternalMetrics();
  }

  @Get("metrics")
  async prometheusMetrics(
    @Headers("x-internal-secret") secret: string,
    @Res() res: Response
  ): Promise<void> {
    const expected = this.configService.get<string>("INTERNAL_METRICS_SECRET");
    if (!expected || secret !== expected) {
      throw new UnauthorizedException("Invalid internal secret");
    }
    const data = await this.metricsService.getMetrics();
    res.setHeader("Content-Type", this.metricsService.contentType());
    res.send(data);
  }
}
