import { Module } from "@nestjs/common";
import { LockLoginService } from "./lock-login.service";
import { LockLoginController } from "./lock-login.controller";
import { LockLoginGuard } from "@src/guards/lock-login.guard";

@Module({
  controllers: [LockLoginController],
  providers: [LockLoginService, LockLoginGuard],
  exports: [LockLoginService, LockLoginGuard],
})
export class LockLoginModule {}
