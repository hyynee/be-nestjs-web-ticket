import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { QueueService } from "./queue.service";
import { QueueProcessor } from "./queue.processor";
import { MailModule } from "@src/services/mail.module";
import { forwardRef } from "@nestjs/common";
import { ExportModule } from "@src/export/export.module";
import { User, UserSchema } from "@src/schemas/user.schema";
import { TicketModule } from "@src/ticket/ticket.module";

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host:
            config.get<string>("REDIS_QUEUE_HOST") ??
            config.getOrThrow<string>("REDIS_HOST"),
          port: parseInt(
            config.get<string>("REDIS_QUEUE_PORT") ??
              config.getOrThrow<string>("REDIS_PORT"),
            10
          ),
          ...((config.get<string>("REDIS_QUEUE_PASSWORD") ??
          config.get<string>("REDIS_PASSWORD"))
            ? {
                password:
                  config.get<string>("REDIS_QUEUE_PASSWORD") ??
                  config.get<string>("REDIS_PASSWORD"),
              }
            : {}),
          db: parseInt(config.get<string>("REDIS_QUEUE_DB") ?? "0", 10),
        },
      }),
    }),
    BullModule.registerQueue({
      name: "default",
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
      },
    }),
    BullModule.registerQueue({
      name: "dead-letter",
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: false,
        removeOnFail: false,
      },
    }),
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    forwardRef(() => MailModule),
    forwardRef(() => ExportModule),
    TicketModule,
  ],
  providers: [QueueProcessor, QueueService],
  exports: [QueueService],
})
export class QueueModule {}
