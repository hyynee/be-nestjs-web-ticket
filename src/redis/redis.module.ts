import { Global, Module } from "@nestjs/common";
import { RedisService } from "./redis.service";
import { RedisSecurityService } from "./redis-security.service";
@Global()
@Module({
  providers: [RedisService, RedisSecurityService],
  exports: [RedisService, RedisSecurityService],
})
export class RedisModule {}
