import { Injectable, NotFoundException } from "@nestjs/common";
import { Model } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { Event } from "@src/schemas/event.schema";
import { CreateEventDTO } from "./dto/create-event.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
@Injectable()
export class EventService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>
  ) { }
  async getEvents(
    query: QueryEventDTO,
    user?: JwtPayload,
  ) {
    const {
      page = 1,
      limit = 10,
    } = query;

    const skip = (page - 1) * limit;
    const isAdmin = user?.role === 'admin';

    const filter: any = {};

    if (!isAdmin) {
      filter.isDeleted = false;
    } else {
      if (query.isDeleted !== undefined) {
        filter.isDeleted = query.isDeleted;
      }
    }
    const [events, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .populate("createdBy", "email fullName")
        .exec(),
      this.eventModel.countDocuments(filter),
    ]);
    return {
      events,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    };
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
      createdBy: currentUser,
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
        { ...eventData, updatedBy: currentUser },
        { new: true }
      )
      .exec();

    if (!updatedEvent) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }
    return updatedEvent;
  }

  async deleteEvent(id: string): Promise<Event> {
    const existingEvent = await this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .exec();
    if (!existingEvent) {
      throw new NotFoundException(
        `Event with ID ${id} not found or has already been deleted`
      );
    }

    existingEvent.isDeleted = true;
    return existingEvent.save();
  }

  async restoreEvent(id: string): Promise<Event> {
    const existingEvent = await this.eventModel
      .findOne({ _id: id, isDeleted: true })
      .exec();
    if (!existingEvent) {
      throw new NotFoundException(`Deleted event with ID ${id} not found`);
    }

    existingEvent.isDeleted = false;
    return existingEvent.save();
  }
}
