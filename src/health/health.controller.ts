import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { HealthService } from "./health.service";

interface HealthLiveResult {
  status: "ok";
}

@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get("live")
  live(): HealthLiveResult {
    const result: HealthLiveResult = { status: "ok" };
    return result;
  }

  @Get("ready")
  async ready(): ReturnType<HealthService["checkReadiness"]> {
    const result = await this.healthService.checkReadiness();

    if (result.status !== "ready") {
      throw new ServiceUnavailableException(result);
    }

    return result;
  }
}
