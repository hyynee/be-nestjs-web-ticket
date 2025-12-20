import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { LockLoginService } from '@src/lock-login/lock-login.service';

@Injectable()
export class LockLoginGuard implements CanActivate {
  constructor(private readonly loginAttemptService: LockLoginService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const email = request.body.email;
    const ip = request.ip;

    const locked = await this.loginAttemptService.isLocked(email, ip);

    if (locked) {
      throw new HttpException(
        'Account is locked due to multiple failed login attempts. Try again later.',
        HttpStatus.LOCKED, // 423: Locked
      );
    }

    return true; 
  }
}
