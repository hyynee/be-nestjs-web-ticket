import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { QueueService } from "./queue.service";
import { QueueController } from "./queue.controller";

const queueRegistrations = BullModule.registerQueue(
  {
    name: "default",
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  },
  {
    name: "dead-letter",
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  }
);

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
    queueRegistrations,
  ],
  controllers: [QueueController],
  providers: [QueueService],
  exports: [QueueService, queueRegistrations],
})
export class QueueModule {}
