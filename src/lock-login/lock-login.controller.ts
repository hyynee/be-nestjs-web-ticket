import { Controller } from '@nestjs/common';
import { LockLoginService } from './lock-login.service';

@Controller('lock-login')
export class LockLoginController {
  constructor(private readonly lockLoginService: LockLoginService) {}
}
