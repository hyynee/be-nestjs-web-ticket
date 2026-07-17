import { Injectable, Logger } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";
import {
  CheckInZoneStatistics,
  HotEventByRevenue,
  RevenueGroupBy,
  RevenueStatisticsResult,
  TopPotentialCustomer,
  TopSellingMetric,
} from "@src/statistical/domain/types/statistical.types";
import { RevenueStatisticsByEventResponseDto } from "@src/statistical/dto/dashboard.dto";
import { DashboardOverviewDto } from "@src/statistical/dto/dashboard.dto";
import { getErrorMessage } from "@src/helper/getErrorMessage";

const CACHE_TTL = {
  HOT_EVENTS: 600,
  TOP_SELLING: 600,
  TOP_CUSTOMERS: 900,
  OVERVIEW_GLOBAL: 300,
  OVERVIEW_EVENT: 120,
  CHECKIN: 30,
  REVENUE: 300,
  REVENUE_EVENT: 120,
} as const;

const STATISTICAL_RESPONSE_SCHEMA_VERSION = "v1";
const STAT_CACHE_PREFIX = `stat:${STATISTICAL_RESPONSE_SCHEMA_VERSION}`;

const CACHE_KEY = {
  HOT_EVENTS: `${STAT_CACHE_PREFIX}:hot-events`,
  TOP_SELLING_TICKETS: `${STAT_CACHE_PREFIX}:top-selling:tickets`,
  TOP_SELLING_REVENUE: `${STAT_CACHE_PREFIX}:top-selling:revenue`,
  TOP_CUSTOMERS: `${STAT_CACHE_PREFIX}:top-customers`,
  OVERVIEW_GLOBAL: `${STAT_CACHE_PREFIX}:overview:global`,
  overviewEvent: (id: string) => `${STAT_CACHE_PREFIX}:overview:event:${id}`,
  checkin: (id: string) => `${STAT_CACHE_PREFIX}:checkin:${id}`,
  revenue: (
    eventId: string | undefined,
    from: string,
    to: string,
    groupBy: RevenueGroupBy
  ) =>
    `${STAT_CACHE_PREFIX}:revenue:${eventId ?? "all"}:${from}:${to}:${groupBy}`,
  revenueEvent: (id: string) => `${STAT_CACHE_PREFIX}:revenue-event:${id}`,
} as const;

@Injectable()
export class StatisticalCacheService {
  private readonly logger = new Logger(StatisticalCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  hotEvents(
    compute: () => Promise<HotEventByRevenue[]>
  ): Promise<HotEventByRevenue[]> {
    return this.withRedisCache(
      CACHE_KEY.HOT_EVENTS,
      CACHE_TTL.HOT_EVENTS,
      compute
    );
  }

  storeHotEvents(compute: () => Promise<HotEventByRevenue[]>): Promise<void> {
    return this.queryAndStore(
      CACHE_KEY.HOT_EVENTS,
      CACHE_TTL.HOT_EVENTS,
      compute
    );
  }

  overviewGlobal(
    compute: () => Promise<DashboardOverviewDto>
  ): Promise<DashboardOverviewDto> {
    return this.withRedisCache(
      CACHE_KEY.OVERVIEW_GLOBAL,
      CACHE_TTL.OVERVIEW_GLOBAL,
      compute
    );
  }

  storeOverviewGlobal(
    compute: () => Promise<DashboardOverviewDto>
  ): Promise<void> {
    return this.queryAndStore(
      CACHE_KEY.OVERVIEW_GLOBAL,
      CACHE_TTL.OVERVIEW_GLOBAL,
      compute
    );
  }

  overviewEvent(
    eventId: string,
    compute: () => Promise<DashboardOverviewDto>
  ): Promise<DashboardOverviewDto> {
    return this.withRedisCache(
      CACHE_KEY.overviewEvent(eventId),
      CACHE_TTL.OVERVIEW_EVENT,
      compute
    );
  }

  revenue(
    eventId: string | undefined,
    from: string,
    to: string,
    groupBy: RevenueGroupBy,
    compute: () => Promise<RevenueStatisticsResult>
  ): Promise<RevenueStatisticsResult> {
    return this.withRedisCache(
      CACHE_KEY.revenue(eventId, from, to, groupBy),
      CACHE_TTL.REVENUE,
      compute
    );
  }

  revenueEvent(
    eventId: string,
    compute: () => Promise<RevenueStatisticsByEventResponseDto>
  ): Promise<RevenueStatisticsByEventResponseDto> {
    return this.withRedisCache(
      CACHE_KEY.revenueEvent(eventId),
      CACHE_TTL.REVENUE_EVENT,
      compute
    );
  }

  topSelling(
    by: TopSellingMetric,
    compute: () => Promise<RevenueStatisticsByEventResponseDto[]>
  ): Promise<RevenueStatisticsByEventResponseDto[]> {
    const key =
      by === "tickets"
        ? CACHE_KEY.TOP_SELLING_TICKETS
        : CACHE_KEY.TOP_SELLING_REVENUE;
    return this.withRedisCache(key, CACHE_TTL.TOP_SELLING, compute);
  }

  storeTopSelling(
    by: TopSellingMetric,
    compute: () => Promise<RevenueStatisticsByEventResponseDto[]>
  ): Promise<void> {
    const key =
      by === "tickets"
        ? CACHE_KEY.TOP_SELLING_TICKETS
        : CACHE_KEY.TOP_SELLING_REVENUE;
    return this.queryAndStore(key, CACHE_TTL.TOP_SELLING, compute);
  }

  topCustomers(
    compute: () => Promise<TopPotentialCustomer[]>
  ): Promise<TopPotentialCustomer[]> {
    return this.withRedisCache(
      CACHE_KEY.TOP_CUSTOMERS,
      CACHE_TTL.TOP_CUSTOMERS,
      compute
    );
  }

  storeTopCustomers(
    compute: () => Promise<TopPotentialCustomer[]>
  ): Promise<void> {
    return this.queryAndStore(
      CACHE_KEY.TOP_CUSTOMERS,
      CACHE_TTL.TOP_CUSTOMERS,
      compute
    );
  }

  checkinZones(
    eventId: string,
    compute: () => Promise<CheckInZoneStatistics[]>
  ): Promise<CheckInZoneStatistics[]> {
    return this.withRedisCache(
      CACHE_KEY.checkin(eventId),
      CACHE_TTL.CHECKIN,
      compute
    );
  }

  private async withRedisCache<T>(
    key: string,
    ttlSec: number,
    compute: () => Promise<T>
  ): Promise<T> {
    try {
      const raw = await this.redisService.client.get(key);
      if (raw) return JSON.parse(raw) as T;
    } catch (err) {
      this.logger.warn(
        `withRedisCache: Redis read failed for "${key}" — ${getErrorMessage(err)}`
      );
    }

    const data = await compute();

    try {
      await this.redisService.client.set(key, JSON.stringify(data), {
        EX: ttlSec,
      });
    } catch (err) {
      this.logger.warn(
        `withRedisCache: Redis write failed for "${key}" — ${getErrorMessage(err)}`
      );
    }

    return data;
  }

  private async queryAndStore<T>(
    key: string,
    ttlSec: number,
    compute: () => Promise<T>
  ): Promise<void> {
    const data = await compute();
    try {
      await this.redisService.client.set(key, JSON.stringify(data), {
        EX: ttlSec,
      });
    } catch (err) {
      this.logger.warn(
        `queryAndStore: Redis write failed for "${key}" — ${getErrorMessage(err)}`
      );
    }
  }
}
