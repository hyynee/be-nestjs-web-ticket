import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";
import { RedisModule } from "@src/redis/redis.module";
import { QueueModule } from "@src/queue/queue.module";

@Module({
  imports: [RedisModule, QueueModule],
  controllers: [HealthController],
  providers: [HealthService],
  exports: [HealthService],
})
export class HealthModule {}
