import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { QueueService } from "./queue.service";
import { QueueController } from "./queue.controller";
import {
  DEAD_LETTER_QUEUE_NAME,
  DEFAULT_QUEUE_NAME,
  EVENT_CANCELLATION_QUEUE_NAME,
} from "./queue.constants";

const queueRegistrations = BullModule.registerQueue(
  {
    name: DEFAULT_QUEUE_NAME,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  },
  {
    name: DEAD_LETTER_QUEUE_NAME,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: false,
      removeOnFail: false,
    },
  },
  {
    // Same retry/backoff semantics as `default` — this fix isolates the
    // WORKER lane (via its own @Processor/Worker), not the retry contract.
    name: EVENT_CANCELLATION_QUEUE_NAME,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
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
