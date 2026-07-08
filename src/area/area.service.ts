import { Model, Types, ClientSession } from "mongoose";
import { CreateAreaDTO } from "./dto/create.dto";
import { InjectModel } from "@nestjs/mongoose";
import { Area } from "@src/schemas/area.schema";
import { BadRequestException, Injectable } from "@nestjs/common";
import { QueryAreaDto } from "./dto/query.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "./dto/update.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { Zone } from "@src/schemas/zone.schema";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { InjectConnection } from "@nestjs/mongoose";
import { Connection } from "mongoose";
import { RedisService } from "@src/redis/redis.service";

const ALLOWED_SORT_FIELDS = [
  "createdAt",
  "name",
  "seatCount",
  "updatedAt",
] as const;
type SortField = (typeof ALLOWED_SORT_FIELDS)[number];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

@Injectable()
export class AreaService {
  private readonly CACHE_PREFIX = "areas:list";
  private readonly SINGLE_CACHE_PREFIX = "area:";

  constructor(
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectConnection() private readonly connection: Connection,
    private readonly redisService: RedisService
  ) {}

  private readonly AREA_CACHE_TTL_SEC = 30;
  private readonly AREA_LIST_INDEX = "areas:list:index";

  private async invalidateAreaCache(areaId: string): Promise<void> {
    try {
      const listKeys = await this.redisService.client.sMembers(
        this.AREA_LIST_INDEX
      );
      const singleKey = `${this.SINGLE_CACHE_PREFIX}${areaId}`;
      const toDelete = [...listKeys, this.AREA_LIST_INDEX, singleKey];
      await this.redisService.client.del(toDelete);
    } catch {
      /* Non-fatal */
    }
  }

  private buildSortedHash(params: Record<string, unknown>): string {
    const sorted = Object.fromEntries(
      Object.entries(params)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    return Buffer.from(JSON.stringify(sorted)).toString("base64");
  }

  private generateListCacheKey(query: QueryAreaDto): string {
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

    const hash = this.buildSortedHash({
      name,
      search,
      hasSeating,
      isDeleted,
      page,
      limit,
      sortBy,
      sortOrder,
    });

    return zoneId
      ? `${this.CACHE_PREFIX}:zone:${zoneId}:${hash}`
      : `${this.CACHE_PREFIX}:global:${hash}`;
  }

  private getAreaSeatCount(area: {
    seatCount?: number;
    seats?: string[];
  }): number {
    if (area.seats && area.seats.length > 0) return area.seats.length;
    return area.seatCount ?? 0;
  }

  private async ensureEventModifiable(
    eventId: Types.ObjectId,
    session?: ClientSession
  ): Promise<void> {
    const event = await this.eventModel
      .findOne({ _id: eventId, isDeleted: false })
      .select("status")
      .lean()
      .session(session ?? null);

    if (!event) {
      throw new BadRequestException("Event not found or has been deleted");
    }

    if (event.status === EventStatus.ENDED) {
      throw new BadRequestException(
        "Cannot modify areas for an event that has already ended"
      );
    }
  }

  private async atomicCapacityIncrement(
    zoneId: Types.ObjectId,
    seatDelta: number,
    session?: ClientSession
  ): Promise<void> {
    if (seatDelta === 0) return;

    if (seatDelta < 0) {
      await this.zoneModel.updateOne(
        { _id: zoneId, isDeleted: false },
        [
          {
            $set: {
              currentTotalSeats: {
                $max: [
                  { $add: [{ $ifNull: ["$currentTotalSeats", 0] }, seatDelta] },
                  0,
                ],
              },
            },
          },
        ],
        { session }
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
      { new: true, session }
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
        `Total seats (${(zone.currentTotalSeats ?? 0) + seatDelta}) would exceed zone capacity (${zone.capacity})`
      );
    }
  }

  async createArea(
    currentUser: { userId: string },
    createAreaDto: CreateAreaDTO
  ): Promise<Area> {
    const { zoneId, name, description, rowLabel, seatCount, seats } =
      createAreaDto;

    if (!Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    if (typeof seatCount === "number" && seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }
    if (
      typeof seatCount === "number" &&
      seatCount > 0 &&
      !rowLabel &&
      (!seats || seats.length === 0)
    ) {
      throw new BadRequestException(
        "rowLabel is required when seatCount is provided"
      );
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
          throw new BadRequestException(
            "This zone does not support seats/areas"
          );

        await this.ensureEventModifiable(zone.eventId, session);

        let finalSeats: string[] = seats ?? [];
        if (
          finalSeats.length === 0 &&
          typeof seatCount === "number" &&
          seatCount > 0 &&
          rowLabel
        ) {
          finalSeats = Array.from(
            { length: seatCount },
            (_, i) => `${rowLabel.toUpperCase()}${i + 1}`
          );
        }

        const normalizedSeatCount = this.getAreaSeatCount({
          seatCount,
          seats: finalSeats,
        });

        await this.atomicCapacityIncrement(
          zoneObjectId,
          normalizedSeatCount,
          session
        );

        const [area] = await this.areaModel.create(
          [
            {
              eventId: zone.eventId,
              zoneId: zoneObjectId,
              name: name.trim().toUpperCase(),
              description,
              rowLabel,
              seatCount: normalizedSeatCount,
              seats: finalSeats,
              createdBy: currentUser.userId,
            },
          ],
          { session }
        );

        savedArea = area;
      });

      await this.invalidateAreaCache(savedArea._id.toString());
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
      zoneId,
      name,
      search,
      hasSeating,
      isDeleted = false,
      page = 1,
      limit = 10,
      sortOrder = "desc",
    } = query;

    const sortBy: SortField = ALLOWED_SORT_FIELDS.includes(
      query.sortBy as SortField
    )
      ? (query.sortBy as SortField)
      : "createdAt";

    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }

    const cacheKey = this.generateListCacheKey({ ...query, sortBy });
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as PaginatedResponse<Area>;

    const skip = (page - 1) * limit;
    const match: any = { isDeleted };
    const sort: any = { [sortBy]: sortOrder === "asc" ? 1 : -1 };

    if (zoneId) match.zoneId = new Types.ObjectId(zoneId);
    if (name)
      match.name = {
        $regex: `^${escapeRegex(name.trim().toUpperCase())}`,
        $options: "i",
      };
    if (search) {
      const escapedSearch = escapeRegex(search);
      match.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { description: { $regex: escapedSearch, $options: "i" } },
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

    await Promise.all([
      this.redisService.client.set(cacheKey, JSON.stringify(paginatedResult), {
        EX: this.AREA_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(this.AREA_LIST_INDEX, cacheKey),
      this.redisService.client.expire(
        this.AREA_LIST_INDEX,
        this.AREA_CACHE_TTL_SEC * 2
      ),
    ]).catch(() => {});
    return paginatedResult;
  }

  async softDeleteArea(
    currentUser: { userId: string },
    id: string,
    dto: SoftDeleteAreaDTO
  ): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const session = await this.connection.startSession();

    try {
      let area: Area;

      await session.withTransaction(async () => {
        const existing = await this.areaModel
          .findOne({ _id: id, isDeleted: !dto.isDeleted })
          .session(session)
          .lean();

        if (!existing) throw new BadRequestException("Area not found");

        if (dto.isDeleted) {
          const activeCount = await this.bookingModel
            .countDocuments({
              areaId: existing._id,
              status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
              isDeleted: false,
            })
            .session(session);

          if (activeCount > 0) {
            throw new BadRequestException(
              `Cannot delete area: ${activeCount} active booking(s) exist`
            );
          }
        }

        const found = await this.areaModel.findOneAndUpdate(
          { _id: id, isDeleted: !dto.isDeleted },
          { isDeleted: dto.isDeleted, updatedBy: currentUser.userId },
          { new: true, session }
        );

        if (!found) throw new BadRequestException("Area not found");

        const seatCount = found.seatCount ?? 0;

        await this.atomicCapacityIncrement(
          found.zoneId,
          dto.isDeleted ? -seatCount : seatCount,
          session
        );

        area = found;
      });

      await this.invalidateAreaCache(id);
      return area!;
    } finally {
      await session.endSession();
    }
  }

  async updateArea(
    currentUser: { userId: string },
    id: string,
    dto: UpdateAreaDTO
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

      await session.withTransaction(async () => {
        const currentArea = await this.areaModel
          .findOne({ _id: areaId, isDeleted: false })
          .session(session);

        if (!currentArea)
          throw new BadRequestException("Area not found or has been deleted");

        const targetZoneId = zoneId
          ? new Types.ObjectId(zoneId)
          : currentArea.zoneId;
        const isMovingZone =
          zoneId && targetZoneId.toString() !== currentArea.zoneId.toString();

        const targetZone = await this.zoneModel
          .findOne({ _id: targetZoneId, isDeleted: false })
          .select("_id eventId hasSeating")
          .lean()
          .session(session);

        if (!targetZone)
          throw new BadRequestException("Zone not found or has been deleted");
        if (!targetZone.hasSeating)
          throw new BadRequestException(
            "Cannot move/update area in a zone without seating"
          );

        await this.ensureEventModifiable(targetZone.eventId, session);

        const nextRowLabel = rowLabel ?? currentArea.rowLabel;
        let nextSeats = seats ?? currentArea.seats ?? [];

        if (
          typeof seatCount === "number" &&
          seatCount > 0 &&
          (!nextRowLabel || nextRowLabel.trim().length === 0) &&
          nextSeats.length === 0
        ) {
          throw new BadRequestException(
            "rowLabel is required when seatCount is provided"
          );
        }

        if (
          typeof seatCount === "number" &&
          seatCount > 0 &&
          nextSeats.length === 0 &&
          nextRowLabel
        ) {
          nextSeats = Array.from(
            { length: seatCount },
            (_, i) => `${nextRowLabel.toUpperCase()}${i + 1}`
          );
        }

        const normalizedSeatCount = this.getAreaSeatCount({
          seatCount: seatCount ?? currentArea.seatCount,
          seats: nextSeats,
        });

        if (isMovingZone) {
          await this.atomicCapacityIncrement(
            currentArea.zoneId,
            -(currentArea.seatCount ?? 0),
            session
          );
          await this.atomicCapacityIncrement(
            targetZoneId,
            normalizedSeatCount,
            session
          );
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
          { new: true, session }
        )) as Area;

        if (!updatedArea)
          throw new BadRequestException("Area not found or has been deleted");
      });

      await this.invalidateAreaCache(id);
      return updatedArea!;
    } catch (err) {
      if (err?.code === 11000) {
        const label = name
          ? `"${name.trim().toUpperCase()}"`
          : "with this name";
        throw new BadRequestException(
          `Area ${label} already exists in this zone`
        );
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
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as Area;

    const area = await this.areaModel
      .findOne({ _id: new Types.ObjectId(id), isDeleted: false })
      .lean()
      .exec();

    if (!area)
      throw new BadRequestException("Area not found or has been deleted");

    await this.redisService.client
      .set(cacheKey, JSON.stringify(area), { EX: this.AREA_CACHE_TTL_SEC })
      .catch(() => {});
    return area;
  }
}
