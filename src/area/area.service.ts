/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Model, Types, ClientSession } from "mongoose";
import { CreateAreaDTO } from "./dto/create.dto";
import { InjectModel } from "@nestjs/mongoose";
import { Area } from "@src/schemas/area.schema";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { QueryAreaDto } from "./dto/query.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "./dto/update.dto";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { Zone } from "@src/schemas/zone.schema";
import { RedisService } from "@src/redis/redis.service";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";

@Injectable()
export class AreaService {
  private readonly CACHE_PREFIX = "areas:list";
  private readonly CACHE_VERSION_KEY = "areas:cache:version";
  // ✅ Fix 2: cache version in-process để giảm Redis hit
  private versionCache: { value: number; expiresAt: number } | null = null;
  private readonly VERSION_LOCAL_TTL_MS = 2000; 

  constructor(
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly redisService: RedisService,
    @InjectConnection() private readonly connection: Connection, 
  ) {}

  private async getCacheVersion(): Promise<number> {
    const now = Date.now();
    if (this.versionCache && this.versionCache.expiresAt > now) {
      return this.versionCache.value;
    }
    const version = await this.redisService.client.get(this.CACHE_VERSION_KEY);
    const parsed = version ? parseInt(version, 10) : 1;
    this.versionCache = { value: parsed, expiresAt: now + this.VERSION_LOCAL_TTL_MS };
    return parsed;
  }

  private async invalidateAreaCache(): Promise<void> {
    await this.redisService.client.incr(this.CACHE_VERSION_KEY);
    this.versionCache = null; 
  }

  private async generateListCacheKey(query: QueryAreaDto): Promise<string> {
    const version = await this.getCacheVersion();
    const {
      zoneId, name, search, hasSeating, isDeleted,
      page = 1, limit = 10, sortBy = "createdAt", sortOrder = "desc",
    } = query;
    return `${this.CACHE_PREFIX}:v${version}:zone=${zoneId || "all"}:name=${name || ""}:search=${search || ""}:hasSeating=${hasSeating ?? "all"}:isDeleted=${isDeleted ?? false}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private getAreaSeatCount(area: {
    seatCount?: number;
    seats?: string[];
  }): number {
    if (area.seats && area.seats.length > 0) {
      return area.seats.length;
    }
    return area.seatCount ?? 0;
  }

  private async validateZoneCapacity(
    zoneId: Types.ObjectId,
    nextAreaSeatCount: number,
    excludeAreaId?: Types.ObjectId,
    session?: ClientSession,
  ): Promise<void> {
    const zone = await this.zoneModel
      .findOne({ _id: zoneId, isDeleted: false })
      .select("capacity")
      .lean()
      .session(session ?? null);

    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }

    const activeAreas = await this.areaModel
      .find({
        zoneId,
        isDeleted: false,
        ...(excludeAreaId ? { _id: { $ne: excludeAreaId } } : {}),
      })
      .select("seatCount seats")
      .lean()
      .session(session ?? null);

    const totalExistingSeats = activeAreas.reduce(
      (sum, area) => sum + this.getAreaSeatCount(area),
      0,
    );
    const totalSeatsAfterChange = totalExistingSeats + nextAreaSeatCount;

    if (totalSeatsAfterChange > zone.capacity) {
      throw new BadRequestException(
        `Total seats in areas (${totalSeatsAfterChange}) exceed zone capacity (${zone.capacity})`,
      );
    }
  }

  async createArea(
    currentUser: { userId: string },
    createAreaDto: CreateAreaDTO,
  ): Promise<Area> {
    const { zoneId, name, description, rowLabel, seatCount, seats } = createAreaDto;

    if (!Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }

    if (typeof seatCount === "number" && seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }

    if (typeof seatCount === "number" && seatCount > 0 && !rowLabel && (!seats || seats.length === 0)) {
      throw new BadRequestException("rowLabel is required when seatCount is provided");
    }

    const session = await this.connection.startSession();
    try {
      let savedArea: Area;

      await session.withTransaction(async () => {
        const zone = await this.zoneModel
          .findOne({ _id: new Types.ObjectId(zoneId), isDeleted: false })
          .select("eventId hasSeating")
          .lean()
          .session(session);

        if (!zone) throw new BadRequestException("Zone not found");
        if (!zone.hasSeating) throw new BadRequestException("This zone does not support seats/areas");

        let finalSeats: string[] = seats ?? [];
        if (finalSeats.length === 0 && typeof seatCount === "number" && seatCount > 0 && rowLabel) {
          finalSeats = Array.from(
            { length: seatCount },
            (_, index) => `${rowLabel.toUpperCase()}${index + 1}`,
          );
        }

        const normalizedSeatCount = this.getAreaSeatCount({ seatCount, seats: finalSeats });

        await this.validateZoneCapacity(
          new Types.ObjectId(zoneId),
          normalizedSeatCount,
          undefined,
          session,
        );

        const [area] = await this.areaModel.create(
          [{
            eventId: zone.eventId,
            zoneId: new Types.ObjectId(zoneId),
            name: name.trim().toUpperCase(),
            description,
            rowLabel,
            seatCount: normalizedSeatCount,
            seats: finalSeats,
            createdBy: currentUser.userId,
          }],
          { session },
        );

        savedArea = area;
      });

      await this.invalidateAreaCache();
      return savedArea!;
    } catch (err) {
      if (err?.code === 11000) {
        throw new BadRequestException("Area name already exists in this zone");
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getAllAreas(query: QueryAreaDto): Promise<PaginatedResponse<Area>> {
    const {
      zoneId, name, search, hasSeating, isDeleted,
      page = 1, limit = 10, sortBy = "createdAt", sortOrder = "desc",
    } = query;

    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }

    const cacheKey = await this.generateListCacheKey(query);
    const cachedData = await this.cacheManager.get<PaginatedResponse<Area>>(cacheKey);
    if (cachedData) return cachedData;

    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: isDeleted ?? false };

    if (zoneId) filter.zoneId = new Types.ObjectId(zoneId);
    if (name) {
      filter.name = { $regex: `^${name.trim().toUpperCase()}`, $options: "i" };
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }
    if (hasSeating === true) filter.seatCount = { $gt: 0 };
    if (hasSeating === false) filter.seatCount = 0;

    const sort: any = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const [data, total] = await Promise.all([
      this.areaModel.find(filter).select("-__v").sort(sort).skip(skip).limit(limit).lean().exec(),
      this.areaModel.countDocuments(filter).exec(),
    ]);

    const totalPages = Math.ceil(total / limit);
    const result: PaginatedResponse<Area> = {
      items: data,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };

    await this.cacheManager.set(cacheKey, result, 30000);
    return result;
  }

  async softDeleteArea(
    currentUser: { userId: string },
    id: string,
    dto: SoftDeleteAreaDTO,
  ): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const area = await this.areaModel.findOneAndUpdate(
      { _id: id, isDeleted: !dto.isDeleted },
      { isDeleted: dto.isDeleted, updatedBy: currentUser.userId },
      { new: true },
    );

    if (!area) throw new BadRequestException("Area not found");

    await this.invalidateAreaCache();
    await this.cacheManager.del(`area:${id}`);
    return area;
  }

  async updateArea(
    currentUser: { userId: string },
    id: string,
    dto: UpdateAreaDTO,
  ): Promise<Area> {
    const { zoneId, name } = dto;

    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    if (typeof dto.seatCount === "number" && dto.seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }

    const session = await this.connection.startSession();
    try {
      let updatedArea: Area;

      await session.withTransaction(async () => {
        const currentArea = await this.areaModel
          .findOne({ _id: new Types.ObjectId(id), isDeleted: false })
          .session(session);
        if (!currentArea) throw new BadRequestException("Area not found or has been deleted");

        const targetZoneId = zoneId ? new Types.ObjectId(zoneId) : currentArea.zoneId;

        const targetZone = await this.zoneModel
          .findOne({ _id: targetZoneId, isDeleted: false })
          .select("_id eventId hasSeating")
          .lean()
          .session(session);

        if (!targetZone) throw new BadRequestException("Zone not found or has been deleted");
        if (!targetZone.hasSeating) throw new BadRequestException("Cannot move/update area in a zone without seating");

        const nextRowLabel = dto.rowLabel ?? currentArea.rowLabel;
        let nextSeats = dto.seats ?? currentArea.seats ?? [];

        if (
          typeof dto.seatCount === "number" && dto.seatCount > 0 &&
          (!nextRowLabel || nextRowLabel.trim().length === 0) &&
          nextSeats.length === 0
        ) {
          throw new BadRequestException("rowLabel is required when seatCount is provided");
        }

        if (typeof dto.seatCount === "number" && dto.seatCount > 0 && nextSeats.length === 0 && nextRowLabel) {
          nextSeats = Array.from(
            { length: dto.seatCount },
            (_, index) => `${nextRowLabel.toUpperCase()}${index + 1}`,
          );
        }

        const normalizedSeatCount = this.getAreaSeatCount({
          seatCount: dto.seatCount ?? currentArea.seatCount,
          seats: nextSeats,
        });

        await this.validateZoneCapacity(
          targetZoneId,
          normalizedSeatCount,
          new Types.ObjectId(id),
          session,
        );

        if (name) {
          const existingArea = await this.areaModel
            .findOne({
              _id: { $ne: new Types.ObjectId(id) },
              zoneId: targetZoneId,
              name: name.trim().toUpperCase(),
              isDeleted: false,
            })
            .session(session);

          if (existingArea) {
            throw new BadRequestException(`Area "${name}" already exists in this zone`);
          }
        }

        const updatePayload: Record<string, unknown> = {
          eventId: targetZone.eventId,
          rowLabel: nextRowLabel,
          seatCount: normalizedSeatCount,
          seats: nextSeats,
          updatedBy: currentUser.userId,
        };
        if (name) updatePayload.name = name.trim().toUpperCase();
        if (dto.description !== undefined) updatePayload.description = dto.description;
        if (zoneId) updatePayload.zoneId = new Types.ObjectId(zoneId);

        const area = await this.areaModel.findOneAndUpdate(
          { _id: new Types.ObjectId(id), isDeleted: false },
          updatePayload,
          { new: true, session },
        );
        if (!area) throw new BadRequestException("Area not found or has been deleted");

        updatedArea = area;
      });

      await this.invalidateAreaCache();
      await this.cacheManager.del(`area:${id}`);
      return updatedArea!;
    } finally {
      await session.endSession();
    }
  }

  async getAreaById(id: string): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const cacheKey = `area:${id}`;
    const cachedArea = await this.cacheManager.get<Area>(cacheKey);
    if (cachedArea) return cachedArea;

    const area = await this.areaModel
      .findOne({ _id: new Types.ObjectId(id), isDeleted: false })
      .lean()
      .exec();
    if (!area) throw new BadRequestException("Area not found or has been deleted");

    await this.cacheManager.set(cacheKey, area, 30000);
    return area;
  }
}