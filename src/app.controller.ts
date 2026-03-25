import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { AppService } from "./app.service";

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get("health")
  health() {
    return this.appService.getHealth();
  }

  @Get("ready")
  ready() {
    const readiness = this.appService.getReadiness();
    if (readiness.status !== "ready") {
      throw new ServiceUnavailableException(readiness);
    }
    return readiness;
  }
}
