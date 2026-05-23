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

const ALLOWED_SORT_FIELDS = ["createdAt", "name", "seatCount", "updatedAt"] as const;
type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

@Injectable()
export class AreaService {
  private readonly CACHE_PREFIX = "areas:list";
  private readonly SINGLE_CACHE_PREFIX = "area:";

  constructor(
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly redisService: RedisService,
    @InjectConnection() private readonly connection: Connection,
  ) {}


  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = 0;
    do {
      const result = await this.redisService.client.scan(cursor, { MATCH: pattern, COUNT: 100 });
      cursor = result.cursor;
      keys.push(...result.keys);
    } while (cursor !== 0);
    return keys;
  }

  private async invalidateAreaCache(areaId: string, zoneId?: string): Promise<void> {
    const toDelete: Promise<any>[] = [
      this.cacheManager.del(`${this.SINGLE_CACHE_PREFIX}${areaId}`),
    ];

    const globalKeys = await this.scanKeys(`${this.CACHE_PREFIX}:global:*`);
    if (globalKeys.length > 0) toDelete.push(this.redisService.client.del(globalKeys));

    if (zoneId) {
      const zoneKeys = await this.scanKeys(`${this.CACHE_PREFIX}:zone:${zoneId}:*`);
      if (zoneKeys.length > 0) toDelete.push(this.redisService.client.del(zoneKeys));
    }

    await Promise.all(toDelete);
  }

  private buildSortedHash(params: Record<string, unknown>): string {
    const sorted = Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
    return Buffer.from(JSON.stringify(sorted)).toString("base64");
  }

  private generateListCacheKey(query: QueryAreaDto): string {
    const {
      zoneId, name, search, hasSeating, isDeleted,
      page = 1, limit = 10, sortBy = "createdAt", sortOrder = "desc",
    } = query;

    const hash = this.buildSortedHash({
      name, search, hasSeating, isDeleted, page, limit, sortBy, sortOrder,
    });

    return zoneId
      ? `${this.CACHE_PREFIX}:zone:${zoneId}:${hash}`
      : `${this.CACHE_PREFIX}:global:${hash}`;
  }


  private getAreaSeatCount(area: { seatCount?: number; seats?: string[] }): number {
    if (area.seats && area.seats.length > 0) return area.seats.length;
    return area.seatCount ?? 0;
  }

  private async atomicCapacityIncrement(
    zoneId: Types.ObjectId,
    seatDelta: number,
    session?: ClientSession,
  ): Promise<void> {
    if (seatDelta === 0) return;

    if (seatDelta < 0) {
      await this.zoneModel.updateOne(
        { _id: zoneId, isDeleted: false },
        { $inc: { currentTotalSeats: seatDelta } },
        { session },
      );
      return;
    }

    const updated = await this.zoneModel.findOneAndUpdate(
      {
        _id: zoneId,
        isDeleted: false,
        $expr: {
          $lte: [
            { $add: [{ $ifNull: ["$currentTotalSeats", 0] }, seatDelta] },
            "$capacity",
          ],
        },
      },
      { $inc: { currentTotalSeats: seatDelta } },
      { new: true, session },
    );

    if (!updated) {
      const zone = await this.zoneModel
        .findOne({ _id: zoneId, isDeleted: false })
        .select("capacity currentTotalSeats")
        .lean()
        .session(session ?? null);

      if (!zone) {
        throw new BadRequestException("Zone not found or has been deleted");
      }

      throw new BadRequestException(
        `Total seats (${(zone.currentTotalSeats ?? 0) + seatDelta}) would exceed zone capacity (${zone.capacity})`,
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
    if (
      typeof seatCount === "number" && seatCount > 0 &&
      !rowLabel && (!seats || seats.length === 0)
    ) {
      throw new BadRequestException("rowLabel is required when seatCount is provided");
    }

    const zoneObjectId = new Types.ObjectId(zoneId);
    const session = await this.connection.startSession();

    try {
      let savedArea!: Area & { _id: Types.ObjectId };

      await session.withTransaction(async () => {
        const zone = await this.zoneModel
          .findOne({ _id: zoneObjectId, isDeleted: false })
          .select("eventId hasSeating")
          .lean()
          .session(session);

        if (!zone) throw new BadRequestException("Zone not found");
        if (!zone.hasSeating)
          throw new BadRequestException("This zone does not support seats/areas");

        let finalSeats: string[] = seats ?? [];
        if (
          finalSeats.length === 0 &&
          typeof seatCount === "number" && seatCount > 0 && rowLabel
        ) {
          finalSeats = Array.from(
            { length: seatCount },
            (_, i) => `${rowLabel.toUpperCase()}${i + 1}`,
          );
        }

        const normalizedSeatCount = this.getAreaSeatCount({ seatCount, seats: finalSeats });

        await this.atomicCapacityIncrement(zoneObjectId, normalizedSeatCount, session);

        const [area] = await this.areaModel.create(
          [{
            eventId: zone.eventId,
            zoneId: zoneObjectId,
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

      await this.invalidateAreaCache(savedArea._id.toString(), zoneId);
      return savedArea;
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
      zoneId, name, search, hasSeating, isDeleted = false,
      page = 1, limit = 10, sortOrder = "desc",
    } = query;

    const sortBy: SortField = ALLOWED_SORT_FIELDS.includes(query.sortBy as SortField)
      ? (query.sortBy as SortField)
      : "createdAt";

    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }

    const cacheKey = this.generateListCacheKey({ ...query, sortBy });
    const cachedData = await this.cacheManager.get<PaginatedResponse<Area>>(cacheKey);
    if (cachedData) return cachedData;

    const skip = (page - 1) * limit;
    const match: any = { isDeleted };
    const sort: any = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    if (zoneId) match.zoneId = new Types.ObjectId(zoneId);
    if (name) match.name = { $regex: `^${name.trim().toUpperCase()}`, $options: "i" };
    if (search) {
      match.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }
    if (hasSeating === true) match.seatCount = { $gt: 0 };
    if (hasSeating === false) match.seatCount = 0;

    const result = await this.areaModel.aggregate([
      { $match: match },
      { $sort: sort },
      {
        $facet: {
          data: [{ $skip: skip }, { $limit: limit }, { $project: { __v: 0 } }],
          count: [{ $count: "total" }],
        },
      },
    ]);

    const data = result[0].data;
    const total = result[0].count[0]?.total ?? 0;
    const totalPages = Math.ceil(total / limit);

    const paginatedResult: PaginatedResponse<Area> = {
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

    await this.cacheManager.set(cacheKey, paginatedResult, 30000);
    return paginatedResult;
  }

  async softDeleteArea(
    currentUser: { userId: string },
    id: string,
    dto: SoftDeleteAreaDTO,
  ): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const session = await this.connection.startSession();

    try {
      let area: Area;

      await session.withTransaction(async () => {
        const found = await this.areaModel.findOneAndUpdate(
          { _id: id, isDeleted: !dto.isDeleted },
          { isDeleted: dto.isDeleted, updatedBy: currentUser.userId },
          { new: true, session },
        );

        if (!found) throw new BadRequestException("Area not found");

        const seatCount = found.seatCount ?? 0;

        await this.atomicCapacityIncrement(
          found.zoneId,
          dto.isDeleted ? -seatCount : seatCount,
          session,
        );

        area = found;
      });

      await this.invalidateAreaCache(id, area!.zoneId?.toString());
      return area!;
    } finally {
      await session.endSession();
    }
  }

  async updateArea(
    currentUser: { userId: string },
    id: string,
    dto: UpdateAreaDTO,
  ): Promise<Area> {
    const { zoneId, name, description, rowLabel, seatCount, seats } = dto;

    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }
    if (typeof seatCount === "number" && seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }

    const areaId = new Types.ObjectId(id);
    const session = await this.connection.startSession();

    try {
      let updatedArea!: Area;
      let oldZoneId: string | undefined;

      await session.withTransaction(async () => {
        const currentArea = await this.areaModel
          .findOne({ _id: areaId, isDeleted: false })
          .session(session);

        if (!currentArea) throw new BadRequestException("Area not found or has been deleted");

        oldZoneId = currentArea.zoneId.toString();

        const targetZoneId = zoneId ? new Types.ObjectId(zoneId) : currentArea.zoneId;
        const isMovingZone =
          zoneId && targetZoneId.toString() !== currentArea.zoneId.toString();

        const targetZone = await this.zoneModel
          .findOne({ _id: targetZoneId, isDeleted: false })
          .select("_id eventId hasSeating")
          .lean()
          .session(session);

        if (!targetZone) throw new BadRequestException("Zone not found or has been deleted");
        if (!targetZone.hasSeating)
          throw new BadRequestException("Cannot move/update area in a zone without seating");

        const nextRowLabel = rowLabel ?? currentArea.rowLabel;
        let nextSeats = seats ?? currentArea.seats ?? [];

        if (
          typeof seatCount === "number" && seatCount > 0 &&
          (!nextRowLabel || nextRowLabel.trim().length === 0) && nextSeats.length === 0
        ) {
          throw new BadRequestException("rowLabel is required when seatCount is provided");
        }

        if (
          typeof seatCount === "number" && seatCount > 0 &&
          nextSeats.length === 0 && nextRowLabel
        ) {
          nextSeats = Array.from(
            { length: seatCount },
            (_, i) => `${nextRowLabel.toUpperCase()}${i + 1}`,
          );
        }

        const normalizedSeatCount = this.getAreaSeatCount({
          seatCount: seatCount ?? currentArea.seatCount,
          seats: nextSeats,
        });

        if (isMovingZone) {
          await this.atomicCapacityIncrement(
            currentArea.zoneId, -(currentArea.seatCount ?? 0), session,
          );
          await this.atomicCapacityIncrement(targetZoneId, normalizedSeatCount, session);
        } else {
          const seatDelta = normalizedSeatCount - (currentArea.seatCount ?? 0);
          await this.atomicCapacityIncrement(targetZoneId, seatDelta, session);
        }

        const updatePayload: Record<string, unknown> = {
          eventId: targetZone.eventId,
          rowLabel: nextRowLabel,
          seatCount: normalizedSeatCount,
          seats: nextSeats,
          updatedBy: currentUser.userId,
        };

        if (name !== undefined) updatePayload.name = name.trim().toUpperCase();
        if (description !== undefined) updatePayload.description = description;
        if (zoneId) updatePayload.zoneId = new Types.ObjectId(zoneId);

        updatedArea = (await this.areaModel.findOneAndUpdate(
          { _id: areaId, isDeleted: false },
          updatePayload,
          { new: true, session },
        )) as Area;

        if (!updatedArea) throw new BadRequestException("Area not found or has been deleted");
      });

      const newZoneId = zoneId ?? updatedArea!.zoneId?.toString();
      await this.invalidateAreaCache(id, newZoneId);

      if (zoneId && oldZoneId && zoneId !== oldZoneId) {
        const oldZoneKeys = await this.scanKeys(`${this.CACHE_PREFIX}:zone:${oldZoneId}:*`);
        if (oldZoneKeys.length > 0) await this.redisService.client.del(oldZoneKeys);
      }

      return updatedArea!;
    } catch (err) {
      if (err?.code === 11000) {
        const label = name ? `"${name.trim().toUpperCase()}"` : "with this name";
        throw new BadRequestException(`Area ${label} already exists in this zone`);
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async getAreaById(id: string): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const cacheKey = `${this.SINGLE_CACHE_PREFIX}${id}`;
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