import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose/dist/common/mongoose.decorators";
import { Zone } from "@src/schemas/zone.schema";
import { FilterQuery, Model, Types } from "mongoose";
import { QueryZoneDto } from "./dto/query-zone.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateZoneDto } from "./dto/create-zone.dto";
import { UpdateZoneDto } from "./dto/update-zone.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Area } from "@src/schemas/area.schema";
import { RedisService } from "@src/redis/redis.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";

const ALLOWED_SORT_FIELDS = [
  "createdAt",
  "name",
  "price",
  "capacity",
  "soldCount",
  "confirmedSoldCount",
] as const;
type SortField = (typeof ALLOWED_SORT_FIELDS)[number];
const ZONE_RESPONSE_SCHEMA_VERSION = "v1";

interface ZoneAreaViewSource {
  _id?: Types.ObjectId | string;
  id?: string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount?: number;
  seats?: string[];
}

interface ZoneViewSource {
  _id?: Types.ObjectId | string;
  id?: string;
  eventId: Types.ObjectId | string;
  name: string;
  description?: string;
  price: number;
  capacity: number;
  currentTotalSeats?: number;
  soldCount?: number;
  confirmedSoldCount?: number;
  hasSeating: boolean;
  saleStartDate?: Date;
  saleEndDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
  areas?: ZoneAreaViewSource[];
}

export interface ZoneAreaView {
  id: string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount: number;
  seats: string[];
}

export interface ZoneView {
  id: string;
  eventId: string;
  name: string;
  description?: string;
  price: number;
  capacity: number;
  currentTotalSeats: number;
  soldCount: number;
  confirmedSoldCount: number;
  hasSeating: boolean;
  saleStartDate?: Date;
  saleEndDate?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ZoneWithAreasView extends ZoneView {
  areas: ZoneAreaView[];
}

function isMongoDuplicateKeyError(
  err: unknown
): err is { code: 11000 | 11001 } {
  if (!err || typeof err !== "object" || !("code" in err)) {
    return false;
  }

  return err.code === 11000 || err.code === 11001;
}

@Injectable()
export class ZoneService {
  private readonly logger = new Logger(ZoneService.name);
  private readonly CACHE_LIST_PREFIX = `zones:list:${ZONE_RESPONSE_SCHEMA_VERSION}`;
  private readonly ZONE_LIST_INDEX = `zones:list:index:${ZONE_RESPONSE_SCHEMA_VERSION}`;
  private readonly ZONE_CACHE_TTL_SEC = 30;
  private readonly ZONE_DETAIL_PREFIX = `zone:detail:${ZONE_RESPONSE_SCHEMA_VERSION}:`;

  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    private readonly redisService: RedisService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  private async ensureActiveEvent(
    eventId: string | Types.ObjectId
  ): Promise<void> {
    const normalizedEventId =
      typeof eventId === "string" ? new Types.ObjectId(eventId) : eventId;
    const event = await this.eventModel
      .findOne({ _id: normalizedEventId, isDeleted: false })
      .select("_id status")
      .lean();

    if (!event) {
      throw new BadRequestException("Event not found or has been deleted");
    }

    if (event.status === EventStatus.ENDED) {
      throw new BadRequestException(
        "Cannot modify zones for an event that has already ended"
      );
    }
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
    return `${this.CACHE_LIST_PREFIX}:event=${eventId || "all"}:search=${search || ""}:hasSeating=${hasSeating ?? "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private toZoneAreaView(area: ZoneAreaViewSource): ZoneAreaView {
    const id = area._id?.toString() ?? area.id;
    if (!id) {
      throw new BadRequestException("Area ID is missing");
    }

    return {
      id,
      name: area.name,
      description: area.description,
      rowLabel: area.rowLabel,
      seatCount: area.seats?.length ?? area.seatCount ?? 0,
      seats: area.seats ?? [],
    };
  }

  private toZoneView(zone: ZoneViewSource): ZoneView {
    const id = zone._id?.toString() ?? zone.id;
    if (!id) {
      throw new BadRequestException("Zone ID is missing");
    }

    return {
      id,
      eventId: zone.eventId.toString(),
      name: zone.name,
      description: zone.description,
      price: zone.price,
      capacity: zone.capacity,
      currentTotalSeats: zone.currentTotalSeats ?? 0,
      soldCount: zone.soldCount ?? 0,
      confirmedSoldCount: zone.confirmedSoldCount ?? 0,
      hasSeating: zone.hasSeating,
      saleStartDate: zone.saleStartDate,
      saleEndDate: zone.saleEndDate,
      createdAt: zone.createdAt,
      updatedAt: zone.updatedAt,
    };
  }

  private toZoneWithAreasView(zone: ZoneViewSource): ZoneWithAreasView {
    return {
      ...this.toZoneView(zone),
      areas: (zone.areas ?? []).map((area) => this.toZoneAreaView(area)),
    };
  }

  private async invalidateZoneCache(): Promise<void> {
    try {
      const keys = await this.redisService.client.sMembers(
        this.ZONE_LIST_INDEX
      );
      const toDelete = [...keys, this.ZONE_LIST_INDEX];
      await this.redisService.client.del(toDelete);
    } catch {
      /* Non-fatal */
    }
  }

  /**
   * Invalidates the zones:list cache and a specific zone's detail cache.
   * Call this whenever a zone's soldCount/confirmedSoldCount changes
   * outside of ZoneService itself (e.g. booking create/cancel/expire),
   * otherwise GET /zone and GET /zone/:id can serve stale availability
   * for up to ZONE_CACHE_TTL_SEC seconds.
   */
  async invalidateZoneAvailabilityCache(
    zoneId: string | Types.ObjectId
  ): Promise<void> {
    await Promise.all([
      this.invalidateZoneCache(),
      this.redisService.client
        .del(`${this.ZONE_DETAIL_PREFIX}${zoneId.toString()}`)
        .catch(() => {}),
    ]).catch((err: Error) =>
      this.logger.warn(
        `Failed to invalidate zone availability cache for zone ${zoneId}: ${err.message}`
      )
    );
  }
  async getAllActiveZones(
    query: QueryZoneDto
  ): Promise<PaginatedResponse<ZoneView>> {
    const {
      eventId,
      search,
      hasSeating,
      page = 1,
      limit = 10,
      sortOrder = "desc",
    } = query;

    const sortBy: SortField = ALLOWED_SORT_FIELDS.includes(
      query.sortBy as SortField
    )
      ? (query.sortBy as SortField)
      : "createdAt";

    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    const cacheKey = this.generateListCacheKey({ ...query, sortBy });
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as PaginatedResponse<ZoneView>;
    const skip = (page - 1) * limit;
    const filter: FilterQuery<Zone> = { isDeleted: false };
    if (eventId) {
      filter.eventId = new Types.ObjectId(eventId);
    }
    if (search) {
      const escapedSearch = escapeRegex(search.trim());
      filter.$or = [
        { name: { $regex: escapedSearch, $options: "i" } },
        { description: { $regex: escapedSearch, $options: "i" } },
      ];
    }
    if (hasSeating !== undefined) {
      filter.hasSeating = hasSeating;
    }
    const sort: Partial<Record<SortField, 1 | -1>> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };
    const [data, total] = await Promise.all([
      this.zoneModel
        .find(filter)
        .select(
          "eventId name description price capacity currentTotalSeats soldCount confirmedSoldCount hasSeating saleStartDate saleEndDate createdAt updatedAt"
        )
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .exec(),
      this.zoneModel.countDocuments(filter).exec(),
    ]);
    const totalPages = Math.ceil(total / limit);
    const result: PaginatedResponse<ZoneView> = {
      items: data.map((zone) => this.toZoneView(zone)),
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
      this.redisService.client.set(cacheKey, JSON.stringify(result), {
        EX: this.ZONE_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(this.ZONE_LIST_INDEX, cacheKey),
      this.redisService.client.expire(
        this.ZONE_LIST_INDEX,
        this.ZONE_CACHE_TTL_SEC * 2
      ),
    ]).catch(() => {});
    return result;
  }

  async getZoneWithAreas(zoneId: string): Promise<ZoneWithAreasView> {
    if (!Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const zones = await this.zoneModel.aggregate<ZoneViewSource>([
      { $match: { _id: new Types.ObjectId(zoneId), isDeleted: false } },
      {
        $lookup: {
          from: "areas",
          let: { zoneId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$zoneId", "$$zoneId"] },
                isDeleted: false,
              },
            },
            {
              $project: {
                _id: 1,
                name: 1,
                description: 1,
                rowLabel: 1,
                seatCount: 1,
                seats: 1,
              },
            },
          ],
          as: "areas",
        },
      },
      {
        $project: {
          _id: 1,
          eventId: 1,
          name: 1,
          price: 1,
          capacity: 1,
          hasSeating: 1,
          currentTotalSeats: 1,
          soldCount: 1,
          confirmedSoldCount: 1,
          saleStartDate: 1,
          saleEndDate: 1,
          areas: 1,
        },
      },
    ]);

    if (zones.length === 0) {
      throw new NotFoundException("Zone not found");
    }
    return this.toZoneWithAreasView(zones[0]);
  }

  async getZoneById(id: string): Promise<ZoneView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const cacheKey = `${this.ZONE_DETAIL_PREFIX}${id}`;
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as ZoneView;
    const zone = await this.zoneModel.findOne({
      _id: new Types.ObjectId(id),
      isDeleted: false,
    });
    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }
    const zoneView = this.toZoneView(zone);
    await this.redisService.client
      .set(cacheKey, JSON.stringify(zoneView), { EX: this.ZONE_CACHE_TTL_SEC })
      .catch(() => {});
    return zoneView;
  }

  async createZone(
    currentUser: JwtPayload,
    createZoneDto: CreateZoneDto
  ): Promise<ZoneView> {
    const { eventId, name } = createZoneDto;
    if (!Types.ObjectId.isValid(createZoneDto.eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      createZoneDto.eventId
    );
    await this.ensureActiveEvent(createZoneDto.eventId);
    const existingZone = await this.zoneModel.findOne({
      eventId: new Types.ObjectId(eventId),
      name: name.trim().toUpperCase(),
      isDeleted: false,
    });
    if (existingZone) {
      throw new BadRequestException(
        `Zone "${name}" already exists in this event`
      );
    }
    const zone = new this.zoneModel({
      ...createZoneDto,
      eventId: new Types.ObjectId(createZoneDto.eventId),
      name: name.trim().toUpperCase(),
      soldCount: 0,
      createdBy: currentUser.userId,
    });
    try {
      const savedZone = await zone.save();
      Object.assign(zone, savedZone);
    } catch (err) {
      if (isMongoDuplicateKeyError(err)) {
        throw new BadRequestException(
          `Zone "${name}" already exists in this event`
        );
      }
      throw err;
    }
    await this.invalidateZoneCache().catch((err: Error) =>
      this.logger.warn(
        `Failed to invalidate zone list cache after create: ${err.message}`
      )
    );
    return this.toZoneView(zone);
  }

  async updateZone(
    currentUser: JwtPayload,
    id: string,
    updateZoneDto: UpdateZoneDto
  ): Promise<ZoneView> {
    const { name, eventId } = updateZoneDto;

    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const currentZone = await this.zoneModel.findOne({
      _id: new Types.ObjectId(id),
      isDeleted: false,
    });
    if (!currentZone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }

    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      currentZone.eventId.toString()
    );

    const targetEventId = eventId
      ? new Types.ObjectId(eventId)
      : currentZone.eventId;

    if (
      eventId &&
      targetEventId.toString() !== currentZone.eventId.toString()
    ) {
      await this.eventOwnershipService.assertCanManageEvent(
        currentUser,
        eventId
      );
    }

    await this.ensureActiveEvent(targetEventId);

    if (name) {
      const existingZone = await this.zoneModel.findOne({
        _id: { $ne: new Types.ObjectId(id) },
        eventId: targetEventId,
        name: name.trim().toUpperCase(),
        isDeleted: false,
      });

      if (existingZone) {
        throw new BadRequestException(
          `Zone "${name}" already exists in this event`
        );
      }
    }

    if (
      updateZoneDto.capacity !== undefined &&
      updateZoneDto.capacity < currentZone.soldCount
    ) {
      throw new BadRequestException(
        `Không thể giảm capacity (${updateZoneDto.capacity}) xuống dưới số vé đã bán (${currentZone.soldCount})`
      );
    }

    if (updateZoneDto.hasSeating === false && currentZone.hasSeating) {
      const activeAreas = await this.areaModel.countDocuments({
        zoneId: new Types.ObjectId(id),
        isDeleted: false,
      });

      if (activeAreas > 0) {
        throw new BadRequestException(
          "Cannot disable seating while active areas still exist in this zone"
        );
      }
    }

    const updatedData = {
      ...updateZoneDto,
      eventId: targetEventId,
      updatedBy: currentUser.userId,
    };
    if (name) {
      updatedData.name = name.trim().toUpperCase();
    }
    const updateFilter: Record<string, unknown> = {
      _id: new Types.ObjectId(id),
      isDeleted: false,
    };

    if (updateZoneDto.capacity !== undefined) {
      updateFilter.soldCount = { $lte: updateZoneDto.capacity };
    }

    let zone: ZoneViewSource | null;
    try {
      zone = await this.zoneModel.findOneAndUpdate(updateFilter, updatedData, {
        new: true,
      });
    } catch (err) {
      if (isMongoDuplicateKeyError(err)) {
        throw new BadRequestException(
          `Zone "${updatedData.name || name || "with that name"}" already exists in this event`
        );
      }
      throw err;
    }
    if (!zone) {
      if (updateZoneDto.capacity !== undefined) {
        throw new ConflictException("Capacity below current sold count");
      }
      throw new BadRequestException("Zone not found or has been deleted");
    }
    await this.invalidateZoneCache().catch((err: Error) =>
      this.logger.warn(
        `Failed to invalidate zone list cache after update: ${err.message}`
      )
    );
    await this.redisService.client
      .del(`${this.ZONE_DETAIL_PREFIX}${id}`)
      .catch(() => {});
    return this.toZoneView(zone);
  }
}
