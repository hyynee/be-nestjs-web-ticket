import { Injectable, Logger } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { RedisService } from "@src/redis/redis.service";
import { QueryZoneDto } from "@src/zone/dto/query-zone.dto";
import { ZoneView } from "@src/zone/domain/types/zone.types";
import { Types } from "mongoose";

const ZONE_RESPONSE_SCHEMA_VERSION = "v1";
const ZONE_CACHE_TTL_SEC = 30;
const CACHE_LIST_PREFIX = `zones:list:${ZONE_RESPONSE_SCHEMA_VERSION}`;
const ZONE_LIST_INDEX = `zones:list:index:${ZONE_RESPONSE_SCHEMA_VERSION}`;
const ZONE_DETAIL_PREFIX = `zone:detail:${ZONE_RESPONSE_SCHEMA_VERSION}:`;

@Injectable()
export class ZoneCacheService {
  private readonly logger = new Logger(ZoneCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  async getList(
    query: QueryZoneDto
  ): Promise<PaginatedResponse<ZoneView> | null> {
    const cacheKey = this.generateListCacheKey(query);
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch((error: unknown) => {
        this.logger.warn(
          `ZoneCacheService: list cache read failed for key=${cacheKey}: ${getErrorMessage(error)}`
        );
        return null;
      });
    if (!cachedRaw) {
      return null;
    }
    return JSON.parse(cachedRaw) as PaginatedResponse<ZoneView>;
  }

  async setList(
    query: QueryZoneDto,
    result: PaginatedResponse<ZoneView>
  ): Promise<void> {
    const cacheKey = this.generateListCacheKey(query);
    await Promise.all([
      this.redisService.client.set(cacheKey, JSON.stringify(result), {
        EX: ZONE_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(ZONE_LIST_INDEX, cacheKey),
      this.redisService.client.expire(ZONE_LIST_INDEX, ZONE_CACHE_TTL_SEC * 2),
    ]).catch((error: unknown) => {
      this.logger.warn(
        `ZoneCacheService: list cache write failed for key=${cacheKey}: ${getErrorMessage(error)}`
      );
    });
  }

  async getDetail(id: string): Promise<ZoneView | null> {
    const cacheKey = this.detailKey(id);
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch((error: unknown) => {
        this.logger.warn(
          `ZoneCacheService: detail cache read failed for key=${cacheKey}: ${getErrorMessage(error)}`
        );
        return null;
      });
    if (!cachedRaw) {
      return null;
    }
    return JSON.parse(cachedRaw) as ZoneView;
  }

  async setDetail(id: string, zoneView: ZoneView): Promise<void> {
    const cacheKey = this.detailKey(id);
    await this.redisService.client
      .set(cacheKey, JSON.stringify(zoneView), { EX: ZONE_CACHE_TTL_SEC })
      .catch((error: unknown) => {
        this.logger.warn(
          `ZoneCacheService: detail cache write failed for key=${cacheKey}: ${getErrorMessage(error)}`
        );
      });
  }

  async invalidateList(): Promise<void> {
    try {
      const keys = await this.redisService.client.sMembers(ZONE_LIST_INDEX);
      const toDelete = [...keys, ZONE_LIST_INDEX];
      await this.redisService.client.del(toDelete);
    } catch (error) {
      this.logger.warn(
        `ZoneCacheService: failed to invalidate zone list cache — ${getErrorMessage(error)}`
      );
    }
  }

  async invalidateDetail(zoneId: string | Types.ObjectId): Promise<void> {
    await this.redisService.client
      .del(this.detailKey(zoneId.toString()))
      .catch((error: unknown) => {
        this.logger.warn(
          `ZoneCacheService: detail cache invalidation failed for zone ${zoneId}: ${getErrorMessage(error)}`
        );
      });
  }

  async invalidateAvailability(zoneId: string | Types.ObjectId): Promise<void> {
    await Promise.all([
      this.invalidateList(),
      this.invalidateDetail(zoneId),
    ]).catch((err: unknown) =>
      this.logger.warn(
        `ZoneCacheService: failed to invalidate zone availability cache for zone ${zoneId}: ${getErrorMessage(err)}`
      )
    );
  }

  private generateListCacheKey(query: QueryZoneDto): string {
    const {
      eventId,
      search,
      hasSeating,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;
    return `${CACHE_LIST_PREFIX}:event=${eventId || "all"}:search=${search || ""}:hasSeating=${hasSeating ?? "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private detailKey(id: string): string {
    return `${ZONE_DETAIL_PREFIX}${id}`;
  }
}
