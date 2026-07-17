import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { RedisService } from "@src/redis/redis.service";
import { Request } from "express";
import { getErrorMessage } from "@src/helper/getErrorMessage";

@Injectable()
/**
 * @deprecated This guard is intentionally not registered for API authentication.
 * Use Passport JwtStrategy via AuthGuard("jwt"), which performs token revocation
 * checks and fails closed when Redis is unavailable.
 */
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

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

    let isBlacklisted: string | null = null;
    try {
      isBlacklisted = await this.redisService.client.get(
        `blacklist:access:${token}`
      );
    } catch (err) {
      this.logger.error(
        `AuthGuard: Redis unavailable, failing closed for blacklist check — ${getErrorMessage(err)}`
      );
      throw new UnauthorizedException("Auth service temporarily unavailable");
    }

    if (isBlacklisted) {
      throw new UnauthorizedException("Token has been revoked");
    }

    try {
      const payload = await this.jwtService.verifyAsync(token);
      request["user"] = payload;
    } catch (error) {
      this.logger.warn(
        `AuthGuard: token verification failed — ${getErrorMessage(error)}`
      );
      throw new UnauthorizedException("Invalid or expired token");
    }

    return true;
  }

  private extractTokenFromCookie(request: Request): string | undefined {
    return request.cookies?.access_token;
  }
}
