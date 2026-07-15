import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { HealthService } from "./health.service";

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  live() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    const result = await this.healthService.checkReadiness();

    if (result.status !== "ready") {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
