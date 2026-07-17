import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectConnection, InjectModel } from "@nestjs/mongoose";
import { MetricsService } from "@src/metrics/metrics.service";
import { Area } from "@src/schemas/area.schema";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { ClientSession, Connection, FilterQuery, Model, Types } from "mongoose";
import { AreaSortField } from "../../area.constants";
import type {
  AreaViewSource,
  AreaZoneMutationSource,
} from "../../domain/types/area.types";

interface AreaPageResult {
  areas: AreaViewSource[];
  total: number;
}

@Injectable()
export class AreaRepository {
  constructor(
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectConnection() private readonly connection: Connection,
    private readonly metricsService: MetricsService
  ) {}

  startSession(): Promise<ClientSession> {
    return this.connection.startSession();
  }

  findZoneForMutation(
    zoneId: Types.ObjectId,
    session: ClientSession
  ): Promise<AreaZoneMutationSource | null> {
    return this.zoneModel
      .findOne({ _id: zoneId, isDeleted: false })
      .select("_id eventId hasSeating")
      .lean<AreaZoneMutationSource>()
      .session(session);
  }

  findEventStatus(
    eventId: Types.ObjectId,
    session?: ClientSession
  ): Promise<{ status: EventStatus } | null> {
    return this.eventModel
      .findOne({ _id: eventId, isDeleted: false })
      .select("status")
      .lean<{ status: EventStatus }>()
      .session(session ?? null);
  }

  async incrementZoneCapacity(
    zoneId: Types.ObjectId,
    seatDelta: number,
    session?: ClientSession
  ): Promise<void> {
    if (seatDelta === 0) {
      return;
    }

    if (seatDelta < 0) {
      const decrement = Math.abs(seatDelta);
      const result = await this.zoneModel.updateOne(
        {
          _id: zoneId,
          isDeleted: false,
          currentTotalSeats: { $gte: decrement },
        },
        { $inc: { currentTotalSeats: -decrement } },
        { session }
      );

      if (result.matchedCount === 1) {
        return;
      }

      const zone = await this.zoneModel
        .findOne({ _id: zoneId, isDeleted: false })
        .select("currentTotalSeats")
        .lean<{ currentTotalSeats?: number }>()
        .session(session ?? null);

      if (!zone) {
        throw new NotFoundException("Zone not found or has been deleted");
      }

      this.metricsService.zoneCapacityInconsistentTotal.inc({
        direction: "decrement",
      });
      throw new ConflictException({
        code: "ZONE_CAPACITY_INCONSISTENT",
        message: `Zone seat capacity is inconsistent: cannot decrement ${decrement} from ${zone.currentTotalSeats ?? 0}`,
      });
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

    if (updated) {
      return;
    }

    const zone = await this.zoneModel
      .findOne({ _id: zoneId, isDeleted: false })
      .select("capacity currentTotalSeats")
      .lean<{ capacity: number; currentTotalSeats?: number }>()
      .session(session ?? null);

    if (!zone) {
      throw new NotFoundException("Zone not found or has been deleted");
    }

    this.metricsService.zoneCapacityInconsistentTotal.inc({
      direction: "increment",
    });
    throw new ConflictException({
      code: "ZONE_CAPACITY_EXCEEDED",
      message: `Total seats (${(zone.currentTotalSeats ?? 0) + seatDelta}) would exceed zone capacity (${zone.capacity})`,
    });
  }

  async createArea(
    input: {
      eventId: Types.ObjectId;
      zoneId: Types.ObjectId;
      name: string;
      description?: string;
      rowLabel?: string;
      seatCount: number;
      seats: string[];
      createdBy: string;
    },
    session: ClientSession
  ): Promise<Area> {
    const [area] = await this.areaModel.create([input], { session });
    return area;
  }

  async findAreasPage(input: {
    match: FilterQuery<Area>;
    sort: Partial<Record<AreaSortField | "_id", 1 | -1>>;
    skip: number;
    limit: number;
  }): Promise<AreaPageResult> {
    const result = await this.areaModel.aggregate<{
      data: AreaViewSource[];
      count: Array<{ total: number }>;
    }>([
      { $match: input.match },
      { $sort: input.sort },
      {
        $facet: {
          data: [
            { $skip: input.skip },
            { $limit: input.limit },
            { $project: { __v: 0 } },
          ],
          count: [{ $count: "total" }],
        },
      },
    ]);

    return {
      areas: result[0].data,
      total: result[0].count[0]?.total ?? 0,
    };
  }

  findActiveAreaById(id: Types.ObjectId): Promise<AreaViewSource | null> {
    return this.areaModel
      .findOne({ _id: id, isDeleted: false })
      .lean<AreaViewSource>()
      .exec();
  }

  findAreaForUpdate(
    areaId: Types.ObjectId,
    session: ClientSession
  ): Promise<Area | null> {
    return this.areaModel
      .findOne({ _id: areaId, isDeleted: false })
      .session(session);
  }

  findAreaByDeletionState(
    id: string,
    isDeleted: boolean,
    session: ClientSession
  ): Promise<AreaViewSource | null> {
    return this.areaModel
      .findOne({ _id: id, isDeleted })
      .session(session)
      .lean<AreaViewSource>();
  }

  countActiveBookingsByArea(
    areaId: Types.ObjectId | string,
    session: ClientSession
  ): Promise<number> {
    return this.bookingModel
      .countDocuments({
        areaId,
        status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
        isDeleted: false,
      })
      .session(session);
  }

  updateAreaDeletionState(
    id: string,
    isDeleted: boolean,
    userId: string,
    session: ClientSession
  ): Promise<Area | null> {
    return this.areaModel.findOneAndUpdate(
      { _id: id, isDeleted: !isDeleted },
      { isDeleted, updatedBy: userId },
      { new: true, session }
    );
  }

  updateArea(
    areaId: Types.ObjectId,
    updatePayload: AreaUpdateInput,
    session: ClientSession
  ): Promise<Area | null> {
    return this.areaModel.findOneAndUpdate(
      { _id: areaId, isDeleted: false },
      updatePayload,
      { new: true, session }
    );
  }
}

export interface AreaUpdateInput {
  eventId: Types.ObjectId;
  zoneId?: Types.ObjectId;
  name?: string;
  description?: string;
  rowLabel?: string;
  seatCount: number;
  seats: string[];
  updatedBy: string;
}
