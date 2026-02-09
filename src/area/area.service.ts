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
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) { }

    private generateListCacheKey(query: QueryAreaDto): string {
        const { zoneId, name, search, page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = query;
        return `areas:list:zone=${zoneId || 'all'}:name=${name || ''}:search=${search || ''}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
    }

    private async invalidateAreaCache(): Promise<void> {
        for (const key of this.AREA_CACHE_LIST_KEY) {
            await this.cacheManager.del(key);
        }
        this.AREA_CACHE_LIST_KEY.clear();
    }

    async createArea(
        currentUser,
        createAreaDto: CreateAreaDTO
    ): Promise<Area> {
        const { zoneId, name, description, rowLabel, seatCount, seats } = createAreaDto;

        if (!Types.ObjectId.isValid(zoneId)) {
            throw new BadRequestException("Invalid zone ID");
        }
        const zone = await this.zoneModel
            .findById(zoneId)
            .select('eventId')
            .lean();

        if (!zone) {
            throw new BadRequestException("Zone not found");
        }

        if (seatCount && seatCount <= 0) {
            throw new BadRequestException("Seat count must be greater than 0");
        }
        if (seatCount && !rowLabel && (!seats || seats.length === 0)) {
            throw new BadRequestException("rowLabel is required when seatCount is provided");
        }

        let finalSeats: string[] = seats ?? [];

        if (
            finalSeats.length === 0 &&
            seatCount &&
            rowLabel
        ) {
            // rowlabel = A ; seatcount = 5 => A1,A2,A3,A4,A5
            finalSeats = Array.from(
                { length: seatCount },
                (_, index) => `${rowLabel.toUpperCase()}${index + 1}` // A1, A2, A3...
            );
        }

        const area = new this.areaModel({
            eventId: zone.eventId,
            zoneId: new Types.ObjectId(zoneId),
            name: name.trim().toUpperCase(),
            description,
            rowLabel,
            seatCount,
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
        const { zoneId, name, search, page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = query;
        if (zoneId && !Types.ObjectId.isValid(zoneId)) {
            throw new BadRequestException("Invalid zone ID");
        }
        const cacheKey = this.generateListCacheKey(query);
        const cachedData = await this.cacheManager.get<PaginatedResponse<Area>>(cacheKey);
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
                $options: 'i',
            };
        }
        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
            ];
        }

        const sort: any = {};
        sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

        // Query song song để tối ưu
        const [data, total] = await Promise.all([
            this.areaModel
                .find(filter)
                .select('-__v')
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .lean()
                .exec(),
            this.areaModel.countDocuments(filter).exec()
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
            }
        };
        await this.cacheManager.set(cacheKey, result, 30000);
        this.AREA_CACHE_LIST_KEY.add(cacheKey);
        return result;
    }

    async softDeleteArea(
        currentUser,
        id: string,
        dto: SoftDeleteAreaDTO,
    ): Promise<Area> {
        if (!Types.ObjectId.isValid(id)) {
            throw new BadRequestException("Invalid area ID");
        }

        const area = await this.areaModel.findOneAndUpdate(
            { _id: id ,isDeleted: false },
            {
                isDeleted: dto.isDeleted,
                updatedBy: currentUser.userId,
            },
            { new: true },
        );

        if (!area) {
            throw new BadRequestException("Area not found");
        }

        await this.invalidateAreaCache();
        await this.cacheManager.del(`area:${id}`);
        return area;
    }

    async updateArea(
        currentUser,
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
        };
        const cacheKey = `area:${id}`;
        const cachedArea = await this.cacheManager.get<Area>(cacheKey);
        if (cachedArea) {
            return cachedArea;
        };
        const area = await this.areaModel.findOne({ _id: new Types.ObjectId(id), isDeleted: false }).lean().exec();
        if (!area) {
            throw new BadRequestException("Area not found or has been deleted");
        }
        await this.cacheManager.set(cacheKey, area, 30000);
        return area;
    }
}
