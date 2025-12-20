import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose/dist/common/mongoose.decorators";
import { Zone } from "@src/schemas/zone.schema";
import { Model, Types } from "mongoose";
import { PaginatedZones, QueryZoneDto } from "./dto/query-zone.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateZoneDto } from "./dto/create-zone.dto";
import { UpdateZoneDto } from "./dto/update-zone.dto";
@Injectable()
export class ZoneService {
  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>
  ) {}
  async getAllActiveZones(query: QueryZoneDto): Promise<PaginatedZones> {
    const { eventId, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;

    const filter: any = { isDeleted: false };

    if (eventId) {
      if (!Types.ObjectId.isValid(eventId)) {
        throw new BadRequestException("Invalid event ID");
      }
      filter.eventId = new Types.ObjectId(eventId);
    }

    const [data, total] = await Promise.all([
      this.zoneModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .exec(),
      this.zoneModel.countDocuments(filter),
    ]);

    return {
      data,
      total,
      page,
      limit,
    };
  }

  async getZoneById(id: string): Promise<Zone> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const zone = await this.zoneModel.findOne({
      _id: new Types.ObjectId(id),
      isDeleted: false,
    });
    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }
    return zone;
  }

  async createZone(
    currentUser: JwtPayload,
    createZoneDto: CreateZoneDto
  ): Promise<Zone> {
    const zone = new this.zoneModel({
      ...createZoneDto,
      createdBy: currentUser.userId,
    });
    await zone.save();
    return zone;
  }

  async updateZone(
    currentUser: JwtPayload,
    id: string,
    updateZoneDto: UpdateZoneDto
  ): Promise<Zone> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const zone = await this.zoneModel.findOneAndUpdate(
      { _id: new Types.ObjectId(id), isDeleted: false },
      {
        ...updateZoneDto,
        updatedBy: currentUser.userId,
      },
      { new: true }
    );
    if (!zone) {
      throw new BadRequestException("Zone not found or has been deleted");
    }
    return zone;
  }
}
