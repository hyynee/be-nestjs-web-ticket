import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { RedisService } from "@src/redis/redis.service";

const END_LOCK_KEY = "cron:lock:end-events";
const END_LOCK_TTL_SEC = 300;

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class EventScheduler {
  private readonly logger = new Logger(EventScheduler.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    private readonly redisService: RedisService
  ) {}

  @Cron("*/5 * * * *")
  async handleAutoEndEvents() {
    const lockValue = uuidv4();
    const acquired = await this.redisService.client
      .set(END_LOCK_KEY, lockValue, { NX: true, EX: END_LOCK_TTL_SEC })
      .catch((err: unknown) => {
        this.logger.error(
          `auto-end-events: Redis lock acquire failed — ${(err as Error)?.message ?? "unknown"}`
        );
        return null;
      });

    if (acquired === null) {
      this.logger.log(
        "auto-end-events: lock held by another instance, skipping this run"
      );
      return;
    }

    try {
      const result = await this.eventModel.updateMany(
        {
          status: { $in: [EventStatus.ACTIVE, EventStatus.INACTIVE] },
          isDeleted: false,
          endDate: { $lte: new Date() },
        },
        { $set: { status: EventStatus.ENDED } }
      );
      if (result.modifiedCount > 0) {
        this.logger.log(
          `auto-end-events: ended ${result.modifiedCount} event(s)`
        );
      }
    } catch (error) {
      this.logger.error(
        `auto-end-events: failed — ${(error as Error)?.message ?? "unknown error"}`
      );
    } finally {
      await this.redisService.client
        .eval(RELEASE_SCRIPT, {
          keys: [END_LOCK_KEY],
          arguments: [lockValue],
        })
        .catch((err: unknown) =>
          this.logger.error(
            `auto-end-events: lock release failed — ${(err as Error)?.message ?? "unknown"}`
          )
        );
    }
  }
}
