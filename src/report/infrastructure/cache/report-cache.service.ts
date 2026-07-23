import { Injectable, Logger } from "@nestjs/common";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { RedisService } from "@src/redis/redis.service";
import { RefundProvider } from "@src/schemas/refund-request.schema";
import { ReportEventScope } from "@src/report/domain/policies/report-scope.policy";
import { ResolvedReportRange } from "@src/report/domain/report-range.util";
import { ReportGroupBy } from "@src/report/domain/types/report.types";

const REPORT_CACHE_SCHEMA_VERSION = "v1";
const REPORT_CACHE_GEN_KEY = `report:${REPORT_CACHE_SCHEMA_VERSION}:gen`;

const CACHE_TTL_SEC = {
  SALES: 180,
  CHECKIN: 30,
  REFUND: 120,
  RECONCILIATION: 60,
  ORGANIZER: 180,
} as const;

/**
 * Report caching uses a single global generation counter instead of
 * SCAN+DEL key-pattern invalidation (rule.md 13.3 "SHOULD dùng
 * revision/version namespace"). Any mutation relevant to reports calls
 * `invalidateAll()` (one Redis INCR); every cache read embeds the current
 * generation in its key, so previously-cached entries are orphaned
 * (never read again) and expire naturally via TTL. This trades precise
 * per-event invalidation for a simple, correct guarantee with O(1)
 * invalidation cost and no risk of stale data surviving past a mutation —
 * acceptable because report queries are not a per-request hot path the
 * way, say, a product page is.
 */
@Injectable()
export class ReportCacheService {
  private readonly logger = new Logger(ReportCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  async invalidateAll(): Promise<void> {
    try {
      await this.redisService.client.incr(REPORT_CACHE_GEN_KEY);
    } catch (err) {
      this.logger.warn(
        `invalidateAll: Redis INCR failed — ${getErrorMessage(err)}`
      );
    }
  }

  salesReport<T>(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    groupBy: ReportGroupBy,
    page: number,
    limit: number,
    compute: () => Promise<T>
  ): Promise<T> {
    return this.withCache(
      [
        "sales",
        this.scopeKey(scope),
        range.fromIso,
        range.toIso,
        groupBy,
        page,
        limit,
      ],
      CACHE_TTL_SEC.SALES,
      compute
    );
  }

  checkInReport<T>(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId: string | undefined,
    page: number,
    limit: number,
    compute: () => Promise<T>
  ): Promise<T> {
    return this.withCache(
      [
        "checkin",
        this.scopeKey(scope),
        range.fromIso,
        range.toIso,
        zoneId ?? "all",
        page,
        limit,
      ],
      CACHE_TTL_SEC.CHECKIN,
      compute
    );
  }

  refundReport<T>(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    provider: RefundProvider | undefined,
    page: number,
    limit: number,
    compute: () => Promise<T>
  ): Promise<T> {
    return this.withCache(
      [
        "refund",
        this.scopeKey(scope),
        range.fromIso,
        range.toIso,
        provider ?? "all",
        page,
        limit,
      ],
      CACHE_TTL_SEC.REFUND,
      compute
    );
  }

  reconciliationReport<T>(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    page: number,
    limit: number,
    compute: () => Promise<T>
  ): Promise<T> {
    return this.withCache(
      [
        "reconciliation",
        this.scopeKey(scope),
        range.fromIso,
        range.toIso,
        page,
        limit,
      ],
      CACHE_TTL_SEC.RECONCILIATION,
      compute
    );
  }

  organizerReport<T>(
    organizerId: string,
    range: ResolvedReportRange,
    page: number,
    limit: number,
    compute: () => Promise<T>
  ): Promise<T> {
    return this.withCache(
      ["organizer", organizerId, range.fromIso, range.toIso, page, limit],
      CACHE_TTL_SEC.ORGANIZER,
      compute
    );
  }

  private scopeKey(scope: ReportEventScope): string {
    if (scope.eventIdEq) return `event-${scope.eventIdEq.toString()}`;
    if (scope.eventIdIn) {
      const ids = scope.eventIdIn.map((id) => id.toString()).sort();
      return `org-${ids.length ? ids.join("_") : "none"}`;
    }
    return "all";
  }

  private async withCache<T>(
    keyParts: (string | number)[],
    ttlSec: number,
    compute: () => Promise<T>
  ): Promise<T> {
    const generation = await this.currentGeneration();
    const key = `report:${REPORT_CACHE_SCHEMA_VERSION}:${keyParts.join(":")}:gen${generation}`;

    try {
      const raw = await this.redisService.client.get(key);
      if (raw) return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(
        `withCache: Redis read failed for "${key}" — ${getErrorMessage(err)}`
      );
    }

    const data = await compute();

    try {
      await this.redisService.client.set(key, JSON.stringify(data), {
        EX: ttlSec,
      });
    } catch (err) {
      this.logger.warn(
        `withCache: Redis write failed for "${key}" — ${getErrorMessage(err)}`
      );
    }

    return data;
  }

  private async currentGeneration(): Promise<string> {
    try {
      return (await this.redisService.client.get(REPORT_CACHE_GEN_KEY)) ?? "0";
    } catch (err) {
      this.logger.warn(
        `currentGeneration: Redis read failed — ${getErrorMessage(err)}`
      );
      return "0";
    }
  }
}
