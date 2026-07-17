import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { FilterQuery, Model, PipelineStage, Types } from "mongoose";
import type {
  EventViewSource,
  EventZoneView,
} from "../../domain/types/event.types";

interface EventPageResult {
  events: EventViewSource[];
  total: number;
}

@Injectable()
export class EventRepository {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>
  ) {}

  findById(eventId: string): Promise<Event | null> {
    return this.eventModel.findById(eventId);
  }

  findEventForZones(
    eventId: string,
    includeDeleted: boolean
  ): Promise<Event | null> {
    return this.eventModel.findOne({
      _id: new Types.ObjectId(eventId),
      ...(includeDeleted ? {} : { isDeleted: false }),
    });
  }

  async findEventsPage(input: {
    filter: FilterQuery<Event>;
    sort: Record<string, 1 | -1>;
    skip: number;
    limit: number;
  }): Promise<EventPageResult> {
    const [events, total] = await Promise.all([
      this.eventModel
        .find(input.filter)
        .sort(input.sort)
        .skip(input.skip)
        .limit(input.limit)
        .lean()
        .populate("createdBy", "email fullName")
        .exec(),
      this.eventModel.countDocuments(input.filter),
    ]);

    return { events, total };
  }

  aggregateEventZones(pipeline: PipelineStage[]): Promise<EventZoneView[]> {
    return this.zoneModel.aggregate<EventZoneView>(pipeline);
  }

  findActiveById(id: string): Promise<Event | null> {
    return this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .populate("createdBy", "email fullName role")
      .exec();
  }

  findDeletedEvents(): Promise<Event[]> {
    return this.eventModel.find({ isDeleted: true }).exec();
  }
}
