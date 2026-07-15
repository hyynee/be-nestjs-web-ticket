import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";

/**
 * Blocks unverified users from booking/payment endpoints. Must run after
 * AuthGuard("jwt") — relies on `request.user.isVerified`, which JwtStrategy
 * refreshes from DB/cache on every request (never trust a stale JWT claim).
 */
@Injectable()
export class VerifiedUserGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: JwtPayload }>();

    if (!request.user?.isVerified) {
      throw new ForbiddenException(
        "Please verify your email address before performing this action"
      );
    }

    return true;
  }
}
