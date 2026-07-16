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
import { MetricsService } from "./metrics/metrics.service";

@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly configService: ConfigService,
    private readonly metricsService: MetricsService
  ) {}

  @Get("health")
  health(): ReturnType<AppService["getHealth"]> {
    return this.appService.getHealth();
  }

  @Get("ready")
  async ready(): ReturnType<AppService["getReadiness"]> {
    const readiness = await this.appService.getReadiness();
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
