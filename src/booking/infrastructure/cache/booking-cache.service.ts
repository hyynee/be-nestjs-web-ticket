import { Injectable } from "@nestjs/common";
import { RedisService } from "@src/redis/redis.service";
import { BOOKING_CACHE_TTL_MS } from "../../booking.constants";
import { QueryBookingDto } from "../../dto/query-booking.dto";

export const BOOKING_RESPONSE_SCHEMA_VERSION = "v1";

@Injectable()
export class BookingCacheService {
  private readonly bookingListIndex = `bookings:list:index:${BOOKING_RESPONSE_SCHEMA_VERSION}`;
  private readonly ttlSec = Math.ceil(BOOKING_CACHE_TTL_MS / 1000);

  constructor(private readonly redisService: RedisService) {}

  get client(): RedisService["client"] {
    return this.redisService.client;
  }

  generateBookingListCacheKey(
    query: QueryBookingDto,
    scopeKey: string
  ): string {
    const {
      eventId,
      search,
      status,
      paymentStatus,
      page,
      limit,
      sortBy,
      sortOrder,
    } = query;
    return `bookings:list:${BOOKING_RESPONSE_SCHEMA_VERSION}:scope=${scopeKey}:event=${eventId || "all"}:search=${search || ""}:status=${status || "all"}:payment=${paymentStatus || "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  generateUserBookingCacheKey(
    userId: string,
    status?: string,
    page: number = 1,
    limit: number = 10
  ): string {
    return `bookings:user:${BOOKING_RESPONSE_SCHEMA_VERSION}:${userId}:status=${status || "all"}:page=${page}:limit=${limit}`;
  }

  generateZoneBookingInfoCacheKey(eventId: string, zoneId: string): string {
    return `zone:booking-info:${BOOKING_RESPONSE_SCHEMA_VERSION}:event=${eventId}:zone=${zoneId}`;
  }

  async getJson<T>(key: string): Promise<T | null> {
    const cachedRaw = await this.redisService.client.get(key).catch(() => null);
    return cachedRaw ? (JSON.parse(cachedRaw) as T) : null;
  }

  async setBookingListCache(key: string, value: unknown): Promise<void> {
    try {
      await Promise.all([
        this.redisService.client.set(key, JSON.stringify(value), {
          EX: this.ttlSec,
        }),
        this.redisService.client.sAdd(this.bookingListIndex, key),
        this.redisService.client.expire(this.bookingListIndex, this.ttlSec * 2),
      ]);
    } catch {
      // Cache failure is non-fatal; DB remains the source of truth.
    }
  }

  async setUserBookingCache(
    userId: string,
    key: string,
    value: unknown
  ): Promise<void> {
    const userIndexKey = `bookings:user:${BOOKING_RESPONSE_SCHEMA_VERSION}:${userId}:index`;
    try {
      await Promise.all([
        this.redisService.client.set(key, JSON.stringify(value), {
          EX: this.ttlSec,
        }),
        this.redisService.client.sAdd(userIndexKey, key),
        this.redisService.client.expire(userIndexKey, this.ttlSec * 2),
      ]);
    } catch {
      // Cache failure is non-fatal; DB remains the source of truth.
    }
  }

  async setZoneBookingInfoCache(
    key: string,
    value: unknown,
    ttlSec: number
  ): Promise<void> {
    await this.redisService.client
      .set(key, JSON.stringify(value), { EX: ttlSec })
      .catch(() => {});
  }

  async invalidateBookingCache(
    eventId?: string,
    zoneId?: string
  ): Promise<void> {
    try {
      const keys = await this.redisService.client.sMembers(
        this.bookingListIndex
      );
      const toDelete = [...keys, this.bookingListIndex];
      if (eventId && zoneId) {
        toDelete.push(this.generateZoneBookingInfoCacheKey(eventId, zoneId));
      }
      await this.redisService.client.del(toDelete);
    } catch {
      // Cache invalidation is best effort.
    }
  }

  async invalidateUserBookingCache(userId: string): Promise<void> {
    try {
      const indexKey = `bookings:user:${BOOKING_RESPONSE_SCHEMA_VERSION}:${userId}:index`;
      const keys = await this.redisService.client.sMembers(indexKey);
      const toDelete = [...keys, indexKey];
      await this.redisService.client.del(toDelete);
    } catch {
      // Cache invalidation is best effort.
    }
  }
}
