/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument */
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Inject
} from "@nestjs/common";
import { Model, Types } from "mongoose";
import { InjectModel} from "@nestjs/mongoose";
import { Event } from "@src/schemas/event.schema";
import { CreateEventDTO } from "./dto/create-event.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
@Injectable()
export class EventService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}

  // Example: cache event list
  async getCachedEvents(query: QueryEventDTO) {
    const cacheKey = `event:list:${JSON.stringify(query)}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;
    const events = await this.getEvents(query);
    await this.cacheManager.set(cacheKey, events, 30);
    return events;
  }

  // Example: cache event by id
  async getEventById(eventId: string) {
    const cacheKey = `event:details:${eventId}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;
    const event = await this.eventModel.findById(eventId);
    if (!event) throw new NotFoundException('Event not found');
    await this.cacheManager.set(cacheKey, event, 60);
    return event;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  async getEvents(
    query: QueryEventDTO,
    user?: JwtPayload
  ) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      status,
    } = query;

    const skip = (page - 1) * limit;
    const isAdmin = user?.role === "admin";

    const filter: any = {};

    if (!isAdmin) {
      filter.isDeleted = false;
    } else {
      if (query.isDeleted !== undefined) {
        filter.isDeleted = query.isDeleted;
      }
    }

    if (search?.trim()) {
      const escaped = this.escapeRegex(search.trim());
      filter.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
        { location: { $regex: escaped, $options: "i" } },
      ];
    }

    if (status) {
      filter.status = status;
    }

    const sort: Record<string, 1 | -1> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const [events, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .populate("createdBy", "email fullName")
        .exec(),
      this.eventModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items: events,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  async getEventZones(eventId: string, user?: JwtPayload) {
    const isAdmin = user?.role === "admin";

    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const event = await this.eventModel.findOne({
      _id: new Types.ObjectId(eventId),
      ...(isAdmin ? {} : { isDeleted: false }),
    });

    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    const pipeline: any[] = [
      {
        $match: {
          eventId: event._id,
          ...(isAdmin ? {} : { isDeleted: false }),
        },
      },
      {
        $lookup: {
          from: "areas",
          localField: "_id",
          foreignField: "zoneId",
          as: "areas",
          pipeline: [
            { $match: { ...(isAdmin ? {} : { isDeleted: false }) } },
            { $sort: { createdAt: 1 } },
            ...(isAdmin
              ? []
              : [
                  {
                    $project: {
                      name: 1,
                    },
                  },
                ]),
          ],
        },
      },
      {
        $addFields: {
          hasAreas: { $gt: [{ $size: "$areas" }, 0] },
        },
      },
      { $sort: { createdAt: 1 } },
    ];

    if (!isAdmin) {
      pipeline.push({
        $project: {
          name: 1,
          price: 1,
          hasSeating: 1,
          hasAreas: 1,
          areas: 1,
        },
      });
    }

    return this.zoneModel.aggregate(pipeline);
  }

  async getActiveEventById(id: string): Promise<Event> {
    const event = await this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .populate("createdBy", "email fullName role")
      .exec();
    if (!event) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }
    return event;
  }

  async getDeletedEvents(): Promise<Event[]> {
    return this.eventModel.find({ isDeleted: true }).exec();
  }

  async createEvent(
    currentUser: JwtPayload,
    eventData: CreateEventDTO
  ): Promise<Event> {
    const newEvent = new this.eventModel({
      createdBy: new Types.ObjectId(currentUser.userId),
      ...eventData,
    });
    return newEvent.save();
  }

  async updateEvent(
    currentUser: JwtPayload,
    id: string,
    eventData: UpdateEventDTO
  ): Promise<Event> {
    const existingEvent = await this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .exec();
    if (!existingEvent) {
      throw new NotFoundException(
        `Event with ID ${id} not found or has been deleted`
      );
    }

    const updatedEvent = await this.eventModel
      .findByIdAndUpdate(
        id,
        { ...eventData, updatedBy: new Types.ObjectId(currentUser.userId) },
        { new: true }
      )
      .exec();

    if (!updatedEvent) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }
    return updatedEvent;
  }

  async deleteEvent(id: string): Promise<Event> {
    const session = await this.eventModel.db.startSession();

    try {
      let deletedEvent: Event | null = null;
      await session.withTransaction(async () => {
        const existingEvent = await this.eventModel
          .findOne({ _id: id, isDeleted: false })
          .session(session)
          .exec();

        if (!existingEvent) {
          throw new NotFoundException(
            `Event with ID ${id} not found or has already been deleted`
          );
        }

        existingEvent.isDeleted = true;
        deletedEvent = await existingEvent.save({ session });

        await this.zoneModel.updateMany(
          { eventId: existingEvent._id, isDeleted: false },
          { $set: { isDeleted: true } },
          { session }
        );

        await this.areaModel.updateMany(
          { eventId: existingEvent._id, isDeleted: false },
          { $set: { isDeleted: true } },
          { session }
        );
      });

      if (!deletedEvent) {
        throw new NotFoundException(
          `Event with ID ${id} not found or has already been deleted`
        );
      }

      return deletedEvent;
    } finally {
      await session.endSession();
    }
  }

  async restoreEvent(id: string): Promise<Event> {
    const session = await this.eventModel.db.startSession();

    try {
      let restoredEvent: Event | null = null;
      await session.withTransaction(async () => {
        const existingEvent = await this.eventModel
          .findOne({ _id: id, isDeleted: true })
          .session(session)
          .exec();

        if (!existingEvent) {
          throw new NotFoundException(`Deleted event with ID ${id} not found`);
        }

        existingEvent.isDeleted = false;
        restoredEvent = await existingEvent.save({ session });

        await this.zoneModel.updateMany(
          { eventId: existingEvent._id, isDeleted: true },
          { $set: { isDeleted: false } },
          { session }
        );

        await this.areaModel.updateMany(
          { eventId: existingEvent._id, isDeleted: true },
          { $set: { isDeleted: false } },
          { session }
        );
      });

      if (!restoredEvent) {
        throw new NotFoundException(`Deleted event with ID ${id} not found`);
      }

      return restoredEvent;
    } finally {
      await session.endSession();
    }
  }
}
