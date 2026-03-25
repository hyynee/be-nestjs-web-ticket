/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import { Model, Types } from "mongoose";
import { CreateAreaDTO } from "./dto/create.dto";
import { InjectModel } from "@nestjs/mongoose";
import { Area } from "@src/schemas/area.schema";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { QueryAreaDto } from "./dto/query.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "./dto/update.dto";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { Zone } from "@src/schemas/zone.schema";

@Injectable()
export class AreaService {
  private readonly AREA_CACHE_LIST_KEY: Set<string> = new Set();
  constructor(
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}

  private generateListCacheKey(query: QueryAreaDto): string {
    const {
      zoneId,
      name,
      search,
      hasSeating,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;
    return `areas:list:zone=${zoneId || "all"}:name=${name || ""}:search=${search || ""}:hasSeating=${hasSeating ?? "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private async invalidateAreaCache(): Promise<void> {
    for (const key of this.AREA_CACHE_LIST_KEY) {
      await this.cacheManager.del(key);
    }
    this.AREA_CACHE_LIST_KEY.clear();
  }

  private getAreaSeatCount(area: { seatCount?: number; seats?: string[] }): number {
    if (area.seats && area.seats.length > 0) {
      return area.seats.length;
    }
    return area.seatCount ?? 0;
  }

  private async validateZoneCapacity(
    zoneId: Types.ObjectId,
    nextAreaSeatCount: number,
    excludeAreaId?: Types.ObjectId
  ): Promise<void> {
    const zone = await this.zoneModel
      .findOne({ _id: zoneId, isDeleted: false })
      .select("capacity")
      .lean();

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
      .lean();

    const totalExistingSeats = activeAreas.reduce(
      (sum, area) => sum + this.getAreaSeatCount(area),
      0
    );
    const totalSeatsAfterChange = totalExistingSeats + nextAreaSeatCount;

    if (totalSeatsAfterChange > zone.capacity) {
      throw new BadRequestException(
        `Total seats in areas (${totalSeatsAfterChange}) exceed zone capacity (${zone.capacity})`
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
    const zone = await this.zoneModel
      .findOne({ _id: new Types.ObjectId(zoneId), isDeleted: false })
      .select("eventId hasSeating")
      .lean();

    if (!zone) {
      throw new BadRequestException("Zone not found");
    }

    if (!zone.hasSeating) {
      throw new BadRequestException(
        "This zone does not support seats/areas"
      );
    }

    if (seatCount && seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }
    if (seatCount && !rowLabel && (!seats || seats.length === 0)) {
      throw new BadRequestException(
        "rowLabel is required when seatCount is provided"
      );
    }

    let finalSeats: string[] = seats ?? [];

    if (finalSeats.length === 0 && seatCount && rowLabel) {
      // rowlabel = A ; seatcount = 5 => A1,A2,A3,A4,A5
      finalSeats = Array.from(
        { length: seatCount },
        (_, index) => `${rowLabel.toUpperCase()}${index + 1}` // A1, A2, A3...
      );
    }

    const normalizedSeatCount = this.getAreaSeatCount({
      seatCount,
      seats: finalSeats,
    });

    await this.validateZoneCapacity(
      new Types.ObjectId(zoneId),
      normalizedSeatCount
    );

    const area = new this.areaModel({
      eventId: zone.eventId,
      zoneId: new Types.ObjectId(zoneId),
      name: name.trim().toUpperCase(),
      description,
      rowLabel,
      seatCount: normalizedSeatCount,
      seats: finalSeats,
      createdBy: currentUser.userId,
    });

    try {
      await area.save();
      await this.invalidateAreaCache();

      return area;
    } catch (err) {
      if (err.code === 11000) {
        throw new BadRequestException("Area name already exists in this zone");
      }
      throw err;
    }
  }

  async getAllAreas(query: QueryAreaDto): Promise<PaginatedResponse<Area>> {
    const {
      zoneId,
      name,
      search,
      hasSeating,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;
    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const cacheKey = this.generateListCacheKey(query);
    const cachedData =
      await this.cacheManager.get<PaginatedResponse<Area>>(cacheKey);
    if (cachedData) {
      return cachedData;
    }

    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };

    if (zoneId) {
      filter.zoneId = new Types.ObjectId(zoneId);
    }
    if (name) {
      filter.name = {
        $regex: `^${name.trim().toUpperCase()}`,
        $options: "i",
      };
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { description: { $regex: search, $options: "i" } },
      ];
    }

    if (hasSeating === true) {
      filter.seatCount = { $gt: 0 };
    }

    if (hasSeating === false) {
      filter.seatCount = 0;
    }

    const sort: any = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    // Query song song để tối ưu
    const [data, total] = await Promise.all([
      this.areaModel
        .find(filter)
        .select("-__v")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
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
    this.AREA_CACHE_LIST_KEY.add(cacheKey);
    return result;
  }

  async softDeleteArea(
    currentUser: { userId: string },
    id: string,
    dto: SoftDeleteAreaDTO
  ): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const area = await this.areaModel.findOneAndUpdate(
      { _id: id, isDeleted: false },
      {
        isDeleted: dto.isDeleted,
        updatedBy: currentUser.userId,
      },
      { new: true }
    );

    if (!area) {
      throw new BadRequestException("Area not found");
    }

    await this.invalidateAreaCache();
    await this.cacheManager.del(`area:${id}`);
    return area;
  }

  async updateArea(
    currentUser: { userId: string },
    id: string,
    dto: UpdateAreaDTO
  ): Promise<Area> {
    const { zoneId, name } = dto;
    if (zoneId && !Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }

    const currentArea = await this.areaModel.findOne({
      _id: new Types.ObjectId(id),
      isDeleted: false,
    });
    if (!currentArea) {
      throw new BadRequestException("Area not found or has been deleted");
    }

    const targetZoneId = zoneId
      ? new Types.ObjectId(zoneId)
      : currentArea.zoneId;

    const targetZone = await this.zoneModel
      .findOne({ _id: targetZoneId, isDeleted: false })
      .select("_id eventId hasSeating")
      .lean();

    if (!targetZone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }

    if (!targetZone.hasSeating) {
      throw new BadRequestException(
        "Cannot move/update area in a zone without seating"
      );
    }

    const nextRowLabel = dto.rowLabel ?? currentArea.rowLabel;
    let nextSeats = dto.seats ?? currentArea.seats ?? [];

    if (dto.seatCount && dto.seatCount <= 0) {
      throw new BadRequestException("Seat count must be greater than 0");
    }

    if (
      dto.seatCount &&
      (!nextRowLabel || nextRowLabel.trim().length === 0) &&
      nextSeats.length === 0
    ) {
      throw new BadRequestException(
        "rowLabel is required when seatCount is provided"
      );
    }

    if (dto.seatCount && nextSeats.length === 0 && nextRowLabel) {
      nextSeats = Array.from(
        { length: dto.seatCount },
        (_, index) => `${nextRowLabel.toUpperCase()}${index + 1}`
      );
    }

    const normalizedSeatCount = this.getAreaSeatCount({
      seatCount: dto.seatCount ?? currentArea.seatCount,
      seats: nextSeats,
    });

    await this.validateZoneCapacity(
      targetZoneId,
      normalizedSeatCount,
      new Types.ObjectId(id)
    );

    if (name) {
      const existingArea = await this.areaModel.findOne({
        _id: { $ne: new Types.ObjectId(id) },
        zoneId: targetZoneId,
        name: name.trim().toUpperCase(),
        isDeleted: false,
      });

      if (existingArea) {
        throw new BadRequestException(
          `Area "${name}" already exists in this zone and event`
        );
      }
    }

    const updatedData = {
      ...dto,
      eventId: targetZone.eventId,
      rowLabel: nextRowLabel,
      seatCount: normalizedSeatCount,
      seats: nextSeats,
      updatedBy: currentUser.userId,
    };
    if (name) {
      updatedData.name = name.trim().toUpperCase();
    }
    const area = await this.areaModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), isDeleted: false },
      updatedData,
      { new: true }
    );
    if (!area) {
      throw new BadRequestException("Area not found or has been deleted");
    }
    await this.invalidateAreaCache();
    await this.cacheManager.del(`area:${id}`);
    return area;
  }

  async getAreaById(id: string): Promise<Area> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid area ID");
    }
    const cacheKey = `area:${id}`;
    const cachedArea = await this.cacheManager.get<Area>(cacheKey);
    if (cachedArea) {
      return cachedArea;
    }
    const area = await this.areaModel
      .findOne({ _id: new Types.ObjectId(id), isDeleted: false })
      .lean()
      .exec();
    if (!area) {
      throw new BadRequestException("Area not found or has been deleted");
    }
    await this.cacheManager.set(cacheKey, area, 30000);
    return area;
  }
}
