import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";

@Controller("health")
export class HealthController {
  constructor(private readonly redisService: RedisService) {}

  @Get("live")
  health() {
    return { status: "ok" };
  }

  @Get("ready")
  async ready() {
    try {
      await this.redisService.client.ping();
      return { status: "ready" };
    } catch {
      throw new ServiceUnavailableException("Redis unavailable");
    }
  }
}
