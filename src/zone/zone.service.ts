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
import { EventOwnershipService } from "@src/event/event-ownership.service";
import {
  ALLOWED_ZONE_SORT_FIELDS,
  ZoneSortField,
  ZoneView,
  ZoneViewSource,
  ZoneWithAreasView,
} from "./domain/types/zone.types";
import { ZoneCacheService } from "./infrastructure/cache/zone-cache.service";
import { ZonePresenter } from "./presenters/zone.presenter";
import { getErrorMessage } from "@src/helper/getErrorMessage";

export type {
  ZoneAreaView,
  ZoneView,
  ZoneWithAreasView,
} from "./domain/types/zone.types";

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

  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    private readonly zoneCache: ZoneCacheService,
    private readonly zonePresenter: ZonePresenter,
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

  async invalidateZoneAvailabilityCache(
    zoneId: string | Types.ObjectId
  ): Promise<void> {
    await this.zoneCache.invalidateAvailability(zoneId);
  }

  private invalidateZoneCache(): Promise<void> {
    return this.zoneCache.invalidateList();
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

    const sortBy: ZoneSortField = ALLOWED_ZONE_SORT_FIELDS.includes(
      query.sortBy as ZoneSortField
    )
      ? (query.sortBy as ZoneSortField)
      : "createdAt";

    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    const normalizedQuery = { ...query, sortBy };
    const cached = await this.zoneCache.getList(normalizedQuery);
    if (cached) return cached;
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
    const sort: Partial<Record<ZoneSortField, 1 | -1>> = {
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
      items: data.map((zone) => this.zonePresenter.toZoneView(zone)),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
    await this.zoneCache.setList(normalizedQuery, result);
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
    return this.zonePresenter.toZoneWithAreasView(zones[0]);
  }

  async getZoneById(id: string): Promise<ZoneView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const cached = await this.zoneCache.getDetail(id);
    if (cached) return cached;
    const zone = await this.zoneModel.findOne({
      _id: new Types.ObjectId(id),
      isDeleted: false,
    });
    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }
    const zoneView = this.zonePresenter.toZoneView(zone);
    await this.zoneCache.setDetail(id, zoneView);
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
    await this.invalidateZoneCache().catch((err: unknown) =>
      this.logger.warn(
        `Failed to invalidate zone list cache after create: ${getErrorMessage(err)}`
      )
    );
    return this.zonePresenter.toZoneView(zone);
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
    await Promise.all([
      this.invalidateZoneCache().catch((err: unknown) =>
        this.logger.warn(
          `Failed to invalidate zone list cache after update: ${getErrorMessage(err)}`
        )
      ),
      this.zoneCache.invalidateDetail(id),
    ]);
    return this.zonePresenter.toZoneView(zone);
  }
}
