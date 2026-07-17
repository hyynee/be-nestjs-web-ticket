import { Injectable, Logger } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { MetricsService } from "@src/metrics/metrics.service";
import { RedisService } from "@src/redis/redis.service";
import {
  AREA_CACHE_TTL_SEC,
  AREA_RESPONSE_SCHEMA_VERSION,
  AreaSortField,
} from "../../area.constants";
import type { AreaView } from "../../domain/types/area.types";

interface AreaListCacheKeyInput {
  zoneId?: string;
  name?: string;
  search?: string;
  hasSeating?: boolean;
  isDeleted?: boolean;
  page?: number;
  limit?: number;
  sortBy?: AreaSortField;
  sortOrder?: "asc" | "desc";
}

@Injectable()
export class AreaCacheService {
  private readonly logger = new Logger(AreaCacheService.name);
  private readonly listPrefix = `areas:list:${AREA_RESPONSE_SCHEMA_VERSION}`;
  private readonly detailPrefix = `area:${AREA_RESPONSE_SCHEMA_VERSION}:`;
  private readonly listIndexKey = `areas:list:index:${AREA_RESPONSE_SCHEMA_VERSION}`;

  constructor(
    private readonly redisService: RedisService,
    private readonly metricsService: MetricsService
  ) {}

  async getAreaList(
    query: AreaListCacheKeyInput,
    sortBy: AreaSortField,
    loader: () => Promise<PaginatedResponse<AreaView>>
  ): Promise<PaginatedResponse<AreaView>> {
    const cacheKey = this.generateListCacheKey({ ...query, sortBy });
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch((error: unknown) => {
        this.logger.warn(
          `Failed to read area list cache: ${this.errorMessage(error)}`
        );
        return null;
      });
    if (cachedRaw) {
      return JSON.parse(cachedRaw) as PaginatedResponse<AreaView>;
    }

    const result = await loader();
    await Promise.all([
      this.redisService.client.set(cacheKey, JSON.stringify(result), {
        EX: AREA_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(this.listIndexKey, cacheKey),
      this.redisService.client.expire(
        this.listIndexKey,
        AREA_CACHE_TTL_SEC * 2
      ),
    ]).catch((error: unknown) => {
      this.logger.warn(
        `Failed to write area list cache: ${this.errorMessage(error)}`
      );
    });
    return result;
  }

  async getAreaDetail(
    areaId: string,
    loader: () => Promise<AreaView>
  ): Promise<AreaView> {
    const cacheKey = this.detailKey(areaId);
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch((error: unknown) => {
        this.logger.warn(
          `Failed to read area detail cache for ${areaId}: ${this.errorMessage(error)}`
        );
        return null;
      });
    if (cachedRaw) {
      return JSON.parse(cachedRaw) as AreaView;
    }

    const area = await loader();
    await this.redisService.client
      .set(cacheKey, JSON.stringify(area), { EX: AREA_CACHE_TTL_SEC })
      .catch((error: unknown) => {
        this.logger.warn(
          `Failed to write area detail cache for ${areaId}: ${this.errorMessage(error)}`
        );
      });
    return area;
  }

  async invalidateAreaCache(areaId: string): Promise<void> {
    try {
      const listKeys = await this.redisService.client.sMembers(
        this.listIndexKey
      );
      const toDelete = [...listKeys, this.listIndexKey, this.detailKey(areaId)];
      await this.redisService.client.del(toDelete);
    } catch (error: unknown) {
      this.metricsService.cacheInvalidationFailureTotal.inc({
        source: "area",
      });
      this.logger.warn(
        `Failed to invalidate area cache for ${areaId}: ${this.errorMessage(error)}`
      );
    }
  }

  private generateListCacheKey(query: AreaListCacheKeyInput): string {
    const {
      zoneId,
      name,
      search,
      hasSeating,
      isDeleted,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;

    const normalized = Object.fromEntries(
      Object.entries({
        name,
        search,
        hasSeating,
        isDeleted,
        page,
        limit,
        sortBy,
        sortOrder,
      })
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    const hash = Buffer.from(JSON.stringify(normalized)).toString("base64");

    return zoneId
      ? `${this.listPrefix}:zone:${zoneId}:${hash}`
      : `${this.listPrefix}:global:${hash}`;
  }

  private detailKey(areaId: string): string {
    return `${this.detailPrefix}${areaId}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
