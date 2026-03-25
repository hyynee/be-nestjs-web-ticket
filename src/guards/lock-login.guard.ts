/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { LockLoginService } from "@src/lock-login/lock-login.service";

@Injectable()
export class LockLoginGuard implements CanActivate {
  constructor(private readonly loginAttemptService: LockLoginService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const rawEmail = request.body?.email;
    if (typeof rawEmail !== "string" || rawEmail.trim() === "") {
      return true;
    }

    const email = rawEmail.trim().toLowerCase();
    const ip = request.ip || request.socket?.remoteAddress || "unknown";

    const locked = await this.loginAttemptService.isLocked(email, ip);

    if (locked) {
      throw new HttpException(
        "Account is locked due to multiple failed login attempts. Try again later.",
        HttpStatus.LOCKED // 423: Locked
      );
    }

    return true;
  }
}
