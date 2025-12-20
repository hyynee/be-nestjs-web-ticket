import { Module } from '@nestjs/common';
import { LockLoginService } from './lock-login.service';
import { LockLoginController } from './lock-login.controller';
import { LoginAttempt, LoginAttemptSchema } from '@src/schemas/lock-login.schema';
import { MongooseModule } from '@nestjs/mongoose';
import { LockLoginGuard } from '@src/guards/lock-login.guard';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: LoginAttempt.name, schema: LoginAttemptSchema },
    ]),
  ],
  controllers: [LockLoginController],
  providers: [LockLoginService,LockLoginGuard],
  exports: [LockLoginService,LockLoginGuard],
})
export class LockLoginModule {}
