import { Injectable, NestMiddleware } from '@nestjs/common';
import { RedisService } from '@src/redis/redis.service';
import { NextFunction, Request, Response } from 'express';

@Injectable()
export class RedisContextMiddleware implements NestMiddleware {
  constructor(private readonly redisService: RedisService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const request = req as any;
    request.redisUserTokenCache = this.redisService.client;
    next();
  }
}