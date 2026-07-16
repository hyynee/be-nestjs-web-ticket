import { Inject, Injectable, Logger } from "@nestjs/common";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { RedisService } from "@src/redis/redis.service";
import { QueryEventDTO } from "../../dto/query-event.dto";
import { EVENT_RESPONSE_SCHEMA_VERSION } from "../../event.constants";
import type { EventView } from "../../domain/types/event.types";

@Injectable()
export class EventCacheService {
  private readonly logger = new Logger(EventCacheService.name);

  constructor(
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    private readonly redisService: RedisService
  ) {}

  async getCachedEvents(
    query: QueryEventDTO,
    loader: () => Promise<PaginatedResponse<EventView>>
  ): Promise<PaginatedResponse<EventView>> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      status,
    } = query;
    const normalized = Object.fromEntries(
      Object.entries({ page, limit, search, sortBy, sortOrder, status })
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    const cacheKey = `event:list:${EVENT_RESPONSE_SCHEMA_VERSION}:${Buffer.from(JSON.stringify(normalized)).toString("base64")}`;
    const cached =
      await this.cacheManager.get<PaginatedResponse<EventView>>(cacheKey);
    if (cached) {
      return cached;
    }

    const events = await loader();
    await this.cacheManager.set(cacheKey, events, 30_000);
    await this.redisService.client
      .sAdd(this.listIndexKey(), cacheKey)
      .catch((error: unknown) => {
        this.logger.warn(
          `Failed to index event list cache key: ${this.errorMessage(error)}`
        );
      });
    await this.redisService.client
      .expire(this.listIndexKey(), 60)
      .catch((error: unknown) => {
        this.logger.warn(
          `Failed to set event list cache index TTL: ${this.errorMessage(error)}`
        );
      });
    return events;
  }

  async getEventDetail(
    eventId: string,
    loader: () => Promise<EventView>
  ): Promise<EventView> {
    const cacheKey = this.detailKey(eventId);
    const cached = await this.cacheManager.get<EventView>(cacheKey);
    if (cached) {
      return cached;
    }

    const event = await loader();
    await this.cacheManager.set(cacheKey, event, 60_000);
    return event;
  }

  async invalidateEventCache(eventId: string): Promise<void> {
    try {
      await this.cacheManager.del(this.detailKey(eventId));

      const listIndexKey = this.listIndexKey();
      const listKeys = await this.redisService.client.sMembers(listIndexKey);
      if (listKeys.length > 0) {
        await Promise.all(listKeys.map((k) => this.cacheManager.del(k)));
        await this.redisService.client.del(listIndexKey);
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Failed to invalidate event cache for ${eventId}: ${this.errorMessage(error)}`
      );
    }
  }

  private detailKey(eventId: string): string {
    return `event:details:${EVENT_RESPONSE_SCHEMA_VERSION}:${eventId}`;
  }

  private listIndexKey(): string {
    return `events:list:index:${EVENT_RESPONSE_SCHEMA_VERSION}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
