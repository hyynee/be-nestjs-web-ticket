// mail.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MailService } from "./mail.services";
@Module({
  imports: [ConfigModule],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}