import { Model, Types } from "mongoose";
import { CreateAreaDTO } from "./dto/create.dto";
import { InjectModel } from "@nestjs/mongoose";
import { Area } from "@src/schemas/area.schema";
import { BadRequestException, Injectable } from "@nestjs/common";
import { PaginatedArea, QueryAreaDto } from "./dto/query.dto";
import { UpdateAreaDTO } from "./dto/update.dto";

@Injectable()
export class AreaService {
    constructor(
        @InjectModel(Area.name) private readonly areaModel: Model<Area>
    ) { }

    async createArea(currentUser, createAreaDto: CreateAreaDTO): Promise<Area> {
        const area = new this.areaModel({
            ...createAreaDto,
            createdBy: currentUser.userId,
        });
        await area.save();
        return area;
    }

    async getAllAreas(query: QueryAreaDto): Promise<PaginatedArea> {
        const { zoneId, search, page = 1, limit = 10 } = query;

        if (zoneId && !Types.ObjectId.isValid(zoneId)) {
            throw new BadRequestException("Invalid zone ID");
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

        // Query song song để tối ưu
        const [data, total] = await Promise.all([
            this.areaModel
                .find(filter)
                .select('-__v')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .exec(),
            this.areaModel.countDocuments(filter).exec()
        ]);

        return {
            data,
            total,
            page,
            limit,
            totalPages: Math.ceil(total / limit)
        };
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
        return area;
    }

    async getAreaById(id: string): Promise<Area> {
        if (!Types.ObjectId.isValid(id)) {
            throw new BadRequestException("Invalid area ID");
        }
        const area = await this.areaModel.findOne({ _id: new Types.ObjectId(id), isDeleted: false }).exec();
        if (!area) {
            throw new BadRequestException("Area not found or has been deleted");
        }
        return area;
    }
}
