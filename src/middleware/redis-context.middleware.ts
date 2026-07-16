import { Injectable, NestMiddleware } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";
import { NextFunction, Request, Response } from "express";

@Injectable()
export class RedisContextMiddleware implements NestMiddleware {
  constructor(private readonly redisService: RedisService) {}

  use(req: Request, _res: Response, next: NextFunction): void {
    req.redisUserTokenCache = this.redisService.client;
    next();
  }
}
