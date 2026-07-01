import {
  Injectable,
  NestMiddleware,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import type { Request, Response, NextFunction } from "express";
import axios from "axios";
import { RedisService } from "@src/redis/redis.service";

// Seed list used as fallback when the dynamic fetch fails and Redis has no cache.
// Updated 2026-05-31 from https://stripe.com/files/ips/ips_webhooks.txt
const STRIPE_WEBHOOK_IPS_SEED = new Set([
  "3.18.12.63",
  "3.130.192.231",
  "13.235.14.237",
  "13.235.122.149",
  "18.211.135.69",
  "35.154.171.200",
  "52.15.183.38",
  "54.88.130.119",
  "54.88.130.237",
  "54.187.174.169",
  "54.187.205.235",
  "54.187.216.72",
]);

const STRIPE_IP_LIST_URL = "https://stripe.com/files/ips/ips_webhooks.txt";
const REDIS_KEY = "stripe:webhook:ips";
const CACHE_TTL_SEC = 24 * 60 * 60; // 24 hours

@Injectable()
export class StripeIpMiddleware implements NestMiddleware {
  private readonly logger = new Logger(StripeIpMiddleware.name);
  private readonly enabled: boolean;
  // In-memory cache to avoid Redis round-trips on every webhook request
  private cachedIps: Set<string> = new Set(STRIPE_WEBHOOK_IPS_SEED);
  private lastRefresh = 0;

  constructor(private readonly redisService: RedisService) {
    const isProduction = process.env.NODE_ENV === "production";
    const explicit = process.env.STRIPE_IP_ALLOWLIST;
    this.enabled = explicit !== undefined ? explicit === "true" : isProduction;

    if (this.enabled) {
      // Warm the in-memory cache on startup without blocking bootstrap
      this.refreshIps().catch((err: unknown) => {
        this.logger.warn(
          `StripeIpMiddleware: initial IP refresh failed — using seed list. Error: ${(err as Error)?.message}`
        );
      });
    }
  }

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    if (!this.enabled) {
      return next();
    }

    // Refresh the in-memory cache every 23 hours (slightly less than the Redis TTL)
    // so the in-memory set stays warm between restarts.
    const ageMs = Date.now() - this.lastRefresh;
    if (ageMs > 23 * 60 * 60 * 1000) {
      this.refreshIps().catch(() => {});
    }

    const clientIp = req.ip ?? "";

    if (!this.cachedIps.has(clientIp)) {
      this.logger.warn(
        `StripeIpMiddleware: rejected webhook from ip=${clientIp}`
      );
      throw new ForbiddenException("Webhook source IP not allowed");
    }

    next();
  }

  async refreshIps(): Promise<void> {
    // 1. Try Redis cache first
    try {
      const cached = await this.redisService.client.get(REDIS_KEY);
      if (cached) {
        const ips = JSON.parse(cached) as string[];
        this.cachedIps = new Set(ips);
        this.lastRefresh = Date.now();
        this.logger.debug(
          `StripeIpMiddleware: loaded ${ips.length} IPs from Redis cache`
        );
        return;
      }
    } catch {
      // Redis unavailable — fall through to HTTP fetch
    }

    // 2. Fetch from Stripe's official URL
    try {
      const response = await axios.get<string>(STRIPE_IP_LIST_URL, {
        timeout: 5_000,
        responseType: "text",
      });
      const ips = (response.data as string)
        .split("\n")
        .map((ip) => ip.trim())
        .filter(Boolean);

      if (ips.length < 5) {
        throw new Error(
          `Suspiciously short IP list (${ips.length} entries) — ignoring`
        );
      }

      this.cachedIps = new Set(ips);
      this.lastRefresh = Date.now();
      this.logger.log(
        `StripeIpMiddleware: refreshed ${ips.length} IPs from Stripe`
      );

      // Write to Redis so other instances share the same list
      await this.redisService.client
        .set(REDIS_KEY, JSON.stringify(ips), { EX: CACHE_TTL_SEC })
        .catch(() => {});
    } catch (err) {
      this.logger.warn(
        `StripeIpMiddleware: IP list fetch failed — retaining current list (${this.cachedIps.size} IPs). Error: ${(err as Error)?.message}`
      );
      // Keep existing cachedIps (seed or last good fetch) — do not clear them
    }
  }
}
