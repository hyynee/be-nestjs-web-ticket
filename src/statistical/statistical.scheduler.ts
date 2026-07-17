import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { StatisticalService } from "./statistical.service";
import { RedisService } from "@src/redis/redis.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";

const LOCK_KEY = "cron:lock:stat-warmup";
const LOCK_TTL_SEC = 270;

const RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class StatisticalScheduler {
  private readonly logger = new Logger(StatisticalScheduler.name);

  constructor(
    private readonly statisticalService: StatisticalService,
    private readonly redisService: RedisService
  ) {}

  @Cron("*/5 * * * *")
  async warmDashboardCache(): Promise<void> {
    const lockValue = `${process.pid}-${Date.now()}`;
    const acquired = await this.redisService.client
      .set(LOCK_KEY, lockValue, { NX: true, EX: LOCK_TTL_SEC })
      .catch((err: unknown) => {
        this.logger.error(
          `stat-warmup: Redis lock acquire failed — ${getErrorMessage(err)}`
        );
        return false;
      });

    if (acquired !== "OK") {
      this.logger.debug("stat-warmup: lock held by another instance, skipping");
      return;
    }

    this.logger.log(
      `stat-warmup: warming global dashboard cache (pid=${process.pid})`
    );
    try {
      await this.statisticalService.warmGlobalCache();
      this.logger.log("stat-warmup: completed");
    } catch (err) {
      this.logger.error(`stat-warmup: failed — ${getErrorMessage(err)}`);
    } finally {
      await this.redisService.client
        .eval(RELEASE_SCRIPT, { keys: [LOCK_KEY], arguments: [lockValue] })
        .catch((err: unknown) =>
          this.logger.error(
            `stat-warmup: lock release failed — ${getErrorMessage(err)}`
          )
        );
    }
  }
}
