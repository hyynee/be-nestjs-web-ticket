import { forwardRef, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MailService } from "./mail.service";
import { QueueModule } from "@src/queue/queue.module";

@Module({
  imports: [ConfigModule, forwardRef(() => QueueModule)],
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
