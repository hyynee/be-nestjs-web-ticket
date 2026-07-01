import { Injectable, Logger } from "@nestjs/common";
import axios from "axios";
import { RedisService } from "@src/redis/redis.service";

const REDIS_KEY = "currency:vnd_per_usd";
const CACHE_TTL_SEC = 60 * 60; // 1 hour
// Open.er-api.com is free without an API key for basic usage.
const RATE_API_URL = "https://open.er-api.com/v6/latest/USD";

// Allowed range guard: reject suspiciously out-of-range values before caching them.
const MIN_VND_PER_USD = 18_000;
const MAX_VND_PER_USD = 35_000;

@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name);
  private readonly envFallback: number;

  constructor(private readonly redisService: RedisService) {
    this.envFallback = parseInt(process.env.VND_TO_USD_RATE || "26000", 10);
  }

  async getVndPerUsd(): Promise<number> {
    // 1. Redis cache
    try {
      const cached = await this.redisService.client.get(REDIS_KEY);
      if (cached) {
        const rate = parseFloat(cached);
        if (this.isRateValid(rate)) return rate;
      }
    } catch {
      // Redis unavailable — fall through to live fetch
    }

    // 2. Live fetch
    try {
      const response = await axios.get<{ rates: Record<string, number> }>(
        RATE_API_URL,
        { timeout: 5_000 }
      );
      const rates = response.data?.rates;
      const vndPerUsd = rates?.VND;

      if (typeof vndPerUsd === "number" && this.isRateValid(vndPerUsd)) {
        await this.redisService.client
          .set(REDIS_KEY, String(vndPerUsd), { EX: CACHE_TTL_SEC })
          .catch(() => {});
        this.logger.log(`CurrencyService: refreshed VND/USD rate=${vndPerUsd}`);
        return vndPerUsd;
      }

      this.logger.warn(
        `CurrencyService: received invalid rate ${String(vndPerUsd)} — using env fallback`
      );
    } catch (err) {
      this.logger.warn(
        `CurrencyService: rate fetch failed — using env fallback. Error: ${(err as Error)?.message}`
      );
    }

    // 3. Env fallback
    return this.envFallback;
  }

  private isRateValid(rate: number): boolean {
    return (
      Number.isFinite(rate) &&
      rate >= MIN_VND_PER_USD &&
      rate <= MAX_VND_PER_USD
    );
  }
}
