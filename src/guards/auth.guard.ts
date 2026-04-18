/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { RedisService } from "@src/redis/redis.service";
import { Request } from "express";

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private readonly redisService: RedisService
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractTokenFromCookie(request);

    if (!token) {
      throw new UnauthorizedException("Token not provided");
    }

    const isBlacklisted = await this.redisService.client.get(
      `blacklist:access:${token}`
    );

    if (isBlacklisted) {
      throw new UnauthorizedException("Token has been revoked");
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      request["user"] = payload;
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }

    return true;
  }
  private extractTokenFromCookie(request: Request): string | undefined {
    return request.cookies?.access_token;
  }
}
