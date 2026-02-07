import { BadRequestException, Injectable, NotFoundException, Inject } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose/dist/common/mongoose.decorators";
import { Zone } from "@src/schemas/zone.schema";
import { Model, Types } from "mongoose";
import { QueryZoneDto } from "./dto/query-zone.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateZoneDto } from "./dto/create-zone.dto";
import { UpdateZoneDto } from "./dto/update-zone.dto";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";

@Injectable()
export class ZoneService {
  private readonly ZONE_CACHE_LIST_KEY: Set<string> = new Set();
  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) { }

  private generateListCacheKey(query: QueryZoneDto): string {
    const { eventId, search, page=1, limit=10, sortBy='createdAt', sortOrder='desc' } = query;
    return `zones:list:event=${eventId || 'all'}:search=${search || ''}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }
  private async invalidateZoneCache(): Promise<void> {
    for (const key of this.ZONE_CACHE_LIST_KEY) {
      await this.cacheManager.del(key);
    }
    this.ZONE_CACHE_LIST_KEY.clear();
  }
  async getAllActiveZones(query: QueryZoneDto): Promise<PaginatedResponse<Zone>> {
    const { eventId, search, page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = query;


    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    const cacheKey = this.generateListCacheKey(query);
    const cachedData = await this.cacheManager.get<PaginatedResponse<Zone>>(cacheKey);
    if (cachedData) {
      return cachedData;
    }
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (eventId) {
      filter.eventId = new Types.ObjectId(eventId);
    }
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } }
      ];
    }
    const sort: any = {};
    sort[sortBy] = sortOrder === 'asc' ? 1 : -1;
    const [data, total] = await Promise.all([
      this.zoneModel
        .find(filter)
        .select('-__v')
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .exec(),
      this.zoneModel.countDocuments(filter).exec()
    ]);
    const totalPages = Math.ceil(total / limit);
    const result: PaginatedResponse<Zone> = {
      items: data,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      }
    };
    await this.cacheManager.set(cacheKey, result, 30000);
    this.ZONE_CACHE_LIST_KEY.add(cacheKey);
    return result;
  }

  async getZoneWithAreas(zoneId: string): Promise<Zone> {
    if (!Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const zones = await this.zoneModel.aggregate([
      { $match: { _id: new Types.ObjectId(zoneId), isDeleted: false } },
      {
        $lookup: {
          from: "areas",
          let: { zoneId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$zoneId", "$$zoneId"] },
                isDeleted: false
              }
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
          hasSeating: 1,
          saleStartDate: 1,
          saleEndDate: 1,
          areas: 1,
        },
      },
    ]);

    if (zones.length === 0) {
      throw new NotFoundException("Zone not found");
    }
    return zones[0];
  }

  async getZoneById(id: string): Promise<Zone> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const cacheKey = `zone:${id}`;
    const cachedData = await this.cacheManager.get<Zone>(cacheKey);
    if (cachedData) {
      return cachedData;
    }
    const zone = await this.zoneModel.findOne({
      _id: new Types.ObjectId(id),
      isDeleted: false,
    });
    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }
    await this.cacheManager.set(cacheKey, zone, 30000);
    return zone;
  }

  async createZone(
    currentUser: JwtPayload,
    createZoneDto: CreateZoneDto
  ): Promise<Zone> {
    const { eventId, name } = createZoneDto;
    if (!Types.ObjectId.isValid(createZoneDto.eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
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
      await this.invalidateZoneCache();
      await zone.save();
      return zone;
    } catch (err: any) {
      if (err.code === 11000) {
        throw new BadRequestException(
          `Zone "${name}" already exists in this event`
        );
      }
      throw err;
    }
  }

  async updateZone(
    currentUser: JwtPayload,
    id: string,
    updateZoneDto: UpdateZoneDto
  ): Promise<Zone> {
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
    const targetEventId = eventId
      ? new Types.ObjectId(eventId)
      : currentZone.eventId;

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
    const updatedData = {
      ...updateZoneDto,
      updatedBy: currentUser.userId,
    };
    if (name) {
      updatedData.name = name.trim().toUpperCase();
    }
    const zone = await this.zoneModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), isDeleted: false },
      updatedData,
      { new: true }
    );

    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }
    await this.invalidateZoneCache();
    await this.cacheManager.del(`zone:${id}`);
    return zone;
  }
}
