import { Model, Types } from "mongoose";
import { CreateAreaDTO } from "./dto/create.dto";
import { InjectModel } from "@nestjs/mongoose";
import { Area } from "@src/schemas/area.schema";
import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { QueryAreaDto } from "./dto/query.dto";
import { UpdateAreaDTO } from "./dto/update.dto";
import { CACHE_MANAGER,Cache } from "@nestjs/cache-manager";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";

@Injectable()
export class AreaService {
    private readonly AREA_CACHE_LIST_KEY: Set<string> = new Set();
    constructor(
        @InjectModel(Area.name) private readonly areaModel: Model<Area>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache,
    ) {}
   
    private generateListCacheKey(query: QueryAreaDto): string {
        const { zoneId, search, page, limit, sortBy, sortOrder } = query;
        return `areas:list:zone=${zoneId || 'all'}:search=${search || ''}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
    }
    
    private async invalidateAreaCache(): Promise<void> {
        for (const key of this.AREA_CACHE_LIST_KEY) {
            await this.cacheManager.del(key);
        }
        this.AREA_CACHE_LIST_KEY.clear();
    }

    async createArea(currentUser, createAreaDto: CreateAreaDTO): Promise<Area> {
        const area = new this.areaModel({
            ...createAreaDto,
            createdBy: currentUser.userId,
        });
        // invalidate cache existing area lists
        await this.invalidateAreaCache();
        await area.save();
        return area;
    }

      async getAllAreas(query: QueryAreaDto): Promise<PaginatedResponse<Area>> {
         const { zoneId, search, page = 1, limit = 10, sortBy = 'createdAt', sortOrder = 'desc' } = query;
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
        await this.cacheManager.set(cacheKey, result,30000);
        this.AREA_CACHE_LIST_KEY.add(cacheKey);
        return result;
    }

    async updateArea(currentUser, id: string, updateAreaDto: UpdateAreaDTO): Promise<Area> {
        if (!currentUser) {
            throw new BadRequestException("Invalid user");
        }
        if (!Types.ObjectId.isValid(id)) {
            throw new BadRequestException("Invalid area ID");
        }
        const area = await this.areaModel.findOneAndUpdate(
            { _id: new Types.ObjectId(id), isDeleted: false },
            { ...updateAreaDto, updatedBy: currentUser.userId },
            { new: true }
        );
        if (!area) {
            throw new BadRequestException("Area not found or has been deleted");
        }
        await this.cacheManager.del(`area:${id}`);
        await this.invalidateAreaCache();
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
