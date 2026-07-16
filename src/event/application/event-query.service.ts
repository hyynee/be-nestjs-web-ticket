import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { Event } from "@src/schemas/event.schema";
import { FilterQuery, PipelineStage, Types } from "mongoose";
import { QueryEventDTO } from "../dto/query-event.dto";
import type { EventView, EventZoneView } from "../domain/types/event.types";
import { EventCacheService } from "../infrastructure/cache/event-cache.service";
import { EventRepository } from "../infrastructure/persistence/event.repository";
import { EventPresenter } from "../presenters/event.presenter";

@Injectable()
export class EventQueryService {
  constructor(
    private readonly eventRepository: EventRepository,
    private readonly eventCacheService: EventCacheService,
    private readonly eventPresenter: EventPresenter
  ) {}

  getCachedEvents(query: QueryEventDTO): Promise<PaginatedResponse<EventView>> {
    return this.eventCacheService.getCachedEvents(query, () =>
      this.getEvents(query)
    );
  }

  getEventById(eventId: string): Promise<EventView> {
    return this.eventCacheService.getEventDetail(eventId, async () => {
      const event = await this.eventRepository.findById(eventId);
      if (!event) {
        throw new NotFoundException("Event not found");
      }
      return this.eventPresenter.toEventView(event);
    });
  }

  async getEvents(
    query: QueryEventDTO,
    user?: JwtPayload
  ): Promise<PaginatedResponse<EventView>> {
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
    const filter: FilterQuery<Event> = {};

    if (!isAdmin) {
      filter.isDeleted = false;
    } else if (query.isDeleted !== undefined) {
      filter.isDeleted = query.isDeleted;
    }

    if (search?.trim()) {
      const escaped = escapeRegex(search.trim());
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

    const { events, total } = await this.eventRepository.findEventsPage({
      filter,
      sort,
      skip,
      limit,
    });

    return this.eventPresenter.toEventPage(events, page, limit, total);
  }

  async getEventZones(
    eventId: string,
    user?: JwtPayload
  ): Promise<EventZoneView[]> {
    const isAdmin = user?.role === "admin";

    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const event = await this.eventRepository.findEventForZones(
      eventId,
      isAdmin
    );
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    const pipeline: PipelineStage[] = [
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

    return this.eventRepository.aggregateEventZones(pipeline);
  }

  async getActiveEventById(id: string): Promise<EventView> {
    const event = await this.eventRepository.findActiveById(id);
    if (!event) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }
    return this.eventPresenter.toEventView(event);
  }

  async getDeletedEvents(): Promise<EventView[]> {
    const events = await this.eventRepository.findDeletedEvents();
    return events.map((event) => this.eventPresenter.toEventView(event));
  }

  async getMyManagedEvents(
    currentUser: JwtPayload,
    query: QueryEventDTO
  ): Promise<PaginatedResponse<EventView>> {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      status,
    } = query;

    const skip = (page - 1) * limit;
    const userObjectId = new Types.ObjectId(currentUser.userId);
    const filter: FilterQuery<Event> = { isDeleted: false };
    const andConditions: FilterQuery<Event>[] = [
      { $or: [{ createdBy: userObjectId }, { organizerIds: userObjectId }] },
    ];

    if (search?.trim()) {
      const escaped = escapeRegex(search.trim());
      andConditions.push({
        $or: [
          { title: { $regex: escaped, $options: "i" } },
          { description: { $regex: escaped, $options: "i" } },
          { location: { $regex: escaped, $options: "i" } },
        ],
      });
    }

    if (status) {
      filter.status = status;
    }
    filter.$and = andConditions;

    const sort: Record<string, 1 | -1> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const { events, total } = await this.eventRepository.findEventsPage({
      filter,
      sort,
      skip,
      limit,
    });

    return this.eventPresenter.toEventPage(events, page, limit, total);
  }
}
