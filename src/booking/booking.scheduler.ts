import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { v4 as uuidv4 } from "uuid";
import { BookingService } from "./booking.service";
import { RedisService } from "@src/redis/redis.service";
import { EXPIRE_BATCH_SIZE } from "./booking.constants";

const EXPIRE_LOCK_KEY = "cron:lock:expire-bookings";
const CLEANUP_LOCK_KEY = "cron:lock:cleanup-bookings";
const EXPIRE_LOCK_TTL_SEC = 300;
const CLEANUP_LOCK_TTL_SEC = 3600;

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class BookingScheduler {
  private readonly logger = new Logger(BookingScheduler.name);

  constructor(
    private readonly bookingService: BookingService,
    private readonly redisService: RedisService
  ) {}

  @Cron("*/1 * * * *")
  async handleExpireBookings() {
    const lockValue = uuidv4();
    const acquired = await this.redisService.client
      .set(EXPIRE_LOCK_KEY, lockValue, { NX: true, EX: EXPIRE_LOCK_TTL_SEC })
      .catch((err: unknown) => {
        this.logger.error(
          `expire-bookings: Redis lock acquire failed — ${(err as Error)?.message ?? "unknown"}`
        );
        return null;
      });

    if (acquired === null) {
      this.logger.log(
        "expire-bookings: lock held by another instance, skipping this run"
      );
      return;
    }

    this.logger.log("expire-bookings: lock acquired");
    try {
      // Loop until batch is not full (no more pending expirations)
      let totalExpired = 0;
      let batchResult: any;
      do {
        batchResult = await this.bookingService.expirePendingBookings();
        totalExpired += batchResult?.expired ?? 0;
      } while ((batchResult?.expired ?? 0) >= EXPIRE_BATCH_SIZE);

      this.logger.log(
        `expire-bookings: completed — totalExpired=${totalExpired}`
      );
    } catch (error) {
      this.logger.error(
        `expire-bookings: failed — ${(error as Error)?.message ?? "unknown error"}`
      );
    } finally {
      await this.redisService.client
        .eval(RELEASE_SCRIPT, {
          keys: [EXPIRE_LOCK_KEY],
          arguments: [lockValue],
        })
        .catch((err: unknown) =>
          this.logger.error(
            `expire-bookings: lock release failed — ${(err as Error)?.message ?? "unknown"}`
          )
        );
      this.logger.log("expire-bookings: lock released");
    }
  }

  @Cron("0 2 * * *")
  async handleCleanupOldBookings() {
    const lockValue = uuidv4();
    const acquired = await this.redisService.client
      .set(CLEANUP_LOCK_KEY, lockValue, { NX: true, EX: CLEANUP_LOCK_TTL_SEC })
      .catch((err: unknown) => {
        this.logger.error(
          `cleanup-bookings: Redis lock acquire failed — ${(err as Error)?.message ?? "unknown"}`
        );
        return null;
      });

    if (acquired === null) {
      this.logger.log(
        "cleanup-bookings: lock held by another instance, skipping this run"
      );
      return;
    }

    this.logger.log("cleanup-bookings: lock acquired");
    try {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      await this.bookingService.cleanupOldBookings(cutoff);
      this.logger.log(
        `cleanup-bookings: completed for cutoff ${cutoff.toISOString()}`
      );
    } catch (error) {
      this.logger.error(
        `cleanup-bookings: failed — ${(error as Error)?.message ?? "unknown error"}`
      );
    } finally {
      await this.redisService.client
        .eval(RELEASE_SCRIPT, {
          keys: [CLEANUP_LOCK_KEY],
          arguments: [lockValue],
        })
        .catch((err: unknown) =>
          this.logger.error(
            `cleanup-bookings: lock release failed — ${(err as Error)?.message ?? "unknown"}`
          )
        );
      this.logger.log("cleanup-bookings: lock released");
    }
  }
}
