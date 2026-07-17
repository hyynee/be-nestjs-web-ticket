import { Injectable, Logger } from "@nestjs/common";
import { QueryTicketDto } from "@src/ticket/dto/query.dto";
import { RedisService } from "@src/redis/redis.service";
import {
  TICKET_CACHE_TTL_SEC,
  TICKET_LIST_INDEX,
  TICKET_RESPONSE_SCHEMA_VERSION,
} from "@src/ticket/ticket.constants";

@Injectable()
export class TicketCacheService {
  private readonly logger = new Logger(TicketCacheService.name);

  constructor(private readonly redisService: RedisService) {}

  generateListCacheKey(query: QueryTicketDto, scopeKey: string): string {
    const {
      eventId,
      zoneId,
      areaId,
      status,
      ticketCode,
      userId,
      page,
      limit,
      sortBy,
      sortOrder,
    } = query;
    return `tickets:list:${TICKET_RESPONSE_SCHEMA_VERSION}:scope=${scopeKey}:event=${eventId || "all"}:zone=${zoneId || "all"}:area=${areaId || "all"}:status=${status || "all"}:ticketCode=${ticketCode || ""}:userId=${userId || "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  generateUserCacheKey(
    userId: string,
    query: {
      bookingId?: string;
      eventId?: string;
      status?: string;
      ticketCode?: string;
      page?: number;
      limit?: number;
      sortBy?: string;
      sortOrder?: string;
    }
  ): string {
    const {
      bookingId,
      eventId,
      status,
      ticketCode,
      page,
      limit,
      sortBy,
      sortOrder,
    } = query;
    return `tickets:user:${TICKET_RESPONSE_SCHEMA_VERSION}:${userId}:bookingId=${bookingId || "all"}:eventId=${eventId || "all"}:status=${status || "all"}:ticketCode=${ticketCode || ""}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  userIndexKey(userId: string): string {
    return `tickets:user:${TICKET_RESPONSE_SCHEMA_VERSION}:${userId}:index`;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const cachedRaw = await this.redisService.client
      .get(key)
      .catch((error: unknown) => {
        this.logger.warn(
          `ticket cache read failed for ${key}: ${(error as Error)?.message ?? String(error)}`
        );
        return null;
      });
    return cachedRaw ? (JSON.parse(cachedRaw) as T) : null;
  }

  async cacheList(key: string, value: unknown): Promise<void> {
    await Promise.all([
      this.redisService.client.set(key, JSON.stringify(value), {
        EX: TICKET_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(TICKET_LIST_INDEX, key),
      this.redisService.client.expire(
        TICKET_LIST_INDEX,
        TICKET_CACHE_TTL_SEC * 2
      ),
    ]).catch((error: unknown) => {
      this.logger.warn(
        `ticket list cache write failed: ${(error as Error)?.message ?? String(error)}`
      );
    });
  }

  async cacheUserList(
    userId: string,
    key: string,
    value: unknown
  ): Promise<void> {
    const indexKey = this.userIndexKey(userId);
    await Promise.all([
      this.redisService.client.set(key, JSON.stringify(value), {
        EX: TICKET_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(indexKey, key),
      this.redisService.client.expire(indexKey, TICKET_CACHE_TTL_SEC * 2),
    ]).catch((error: unknown) => {
      this.logger.warn(
        `ticket user cache write failed for user ${userId}: ${(error as Error)?.message ?? String(error)}`
      );
    });
  }

  async invalidateTicketCache(): Promise<void> {
    try {
      const keys = await this.redisService.client.sMembers(TICKET_LIST_INDEX);
      const toDelete = [...keys, TICKET_LIST_INDEX];
      await this.redisService.client.del(toDelete);
    } catch (error) {
      this.logger.warn(
        `ticket cache invalidation failed: ${(error as Error)?.message ?? String(error)}`
      );
    }
  }

  async invalidateUserTicketCache(userId: string): Promise<void> {
    if (!userId) {
      return;
    }

    try {
      const indexKey = this.userIndexKey(userId);
      const keys = await this.redisService.client.sMembers(indexKey);
      const toDelete = [...keys, indexKey];
      await this.redisService.client.del(toDelete);
    } catch (error) {
      this.logger.warn(
        `ticket user cache invalidation failed for user ${userId}: ${(error as Error)?.message ?? String(error)}`
      );
    }
  }
}
