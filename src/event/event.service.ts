import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { EventCommandService } from "./application/event-command.service";
import { EventLifecycleService } from "./application/event-lifecycle.service";
import { EventMemberService } from "./application/event-member.service";
import { EventQueryService } from "./application/event-query.service";
import type { EventCancellationJobDetail } from "./domain/types/event-cancellation.types";
import type {
  EventUserView,
  EventView,
  EventZoneView,
} from "./domain/types/event.types";
import { CreateEventDTO } from "./dto/create-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";

export type { EventCancellationJobDetail } from "./domain/types/event-cancellation.types";
export type {
  EventTimeSlotView,
  EventUserView,
  EventView,
  EventZoneAreaView,
  EventZoneView,
} from "./domain/types/event.types";

@Injectable()
export class EventService {
  constructor(
    private readonly eventQueryService: EventQueryService,
    private readonly eventCommandService: EventCommandService,
    private readonly eventMemberService: EventMemberService,
    private readonly eventLifecycleService: EventLifecycleService
  ) {}

  getCachedEvents(query: QueryEventDTO): Promise<PaginatedResponse<EventView>> {
    return this.eventQueryService.getCachedEvents(query);
  }

  getEventById(eventId: string): Promise<EventView> {
    return this.eventQueryService.getEventById(eventId);
  }

  getEvents(
    query: QueryEventDTO,
    user?: JwtPayload
  ): Promise<PaginatedResponse<EventView>> {
    return this.eventQueryService.getEvents(query, user);
  }

  getEventZones(eventId: string, user?: JwtPayload): Promise<EventZoneView[]> {
    return this.eventQueryService.getEventZones(eventId, user);
  }

  getActiveEventById(id: string): Promise<EventView> {
    return this.eventQueryService.getActiveEventById(id);
  }

  getDeletedEvents(): Promise<EventView[]> {
    return this.eventQueryService.getDeletedEvents();
  }

  getMyManagedEvents(
    currentUser: JwtPayload,
    query: QueryEventDTO
  ): Promise<PaginatedResponse<EventView>> {
    return this.eventQueryService.getMyManagedEvents(currentUser, query);
  }

  createEvent(
    currentUser: JwtPayload,
    dto: CreateEventDTO
  ): Promise<EventView> {
    return this.eventCommandService.createEvent(currentUser, dto);
  }

  updateEvent(
    currentUser: JwtPayload,
    id: string,
    dto: UpdateEventDTO
  ): Promise<EventView> {
    return this.eventCommandService.updateEvent(currentUser, id, dto);
  }

  deleteEvent(id: string): Promise<EventView> {
    return this.eventCommandService.deleteEvent(id);
  }

  restoreEvent(id: string): Promise<EventView> {
    return this.eventCommandService.restoreEvent(id);
  }

  addOrganizerToEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<EventView> {
    return this.eventMemberService.addOrganizerToEvent(
      currentUser,
      eventId,
      targetUserId
    );
  }

  removeOrganizerFromEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<EventView> {
    return this.eventMemberService.removeOrganizerFromEvent(
      currentUser,
      eventId,
      targetUserId
    );
  }

  getEventStaff(
    currentUser: JwtPayload,
    eventId: string
  ): Promise<EventUserView[]> {
    return this.eventMemberService.getEventStaff(currentUser, eventId);
  }

  addStaffToEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string,
    notes?: string
  ): Promise<EventView> {
    return this.eventMemberService.addStaffToEvent(
      currentUser,
      eventId,
      targetUserId,
      notes
    );
  }

  removeStaffFromEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<EventView> {
    return this.eventMemberService.removeStaffFromEvent(
      currentUser,
      eventId,
      targetUserId
    );
  }

  publishEvent(currentUser: JwtPayload, eventId: string): Promise<EventView> {
    return this.eventLifecycleService.publishEvent(currentUser, eventId);
  }

  unpublishEvent(currentUser: JwtPayload, eventId: string): Promise<EventView> {
    return this.eventLifecycleService.unpublishEvent(currentUser, eventId);
  }

  endEvent(currentUser: JwtPayload, eventId: string): Promise<EventView> {
    return this.eventLifecycleService.endEvent(currentUser, eventId);
  }

  cancelEventWithRefund(
    eventId: string,
    adminId: string,
    reason?: string
  ): Promise<EventCancellationJobDetail> {
    return this.eventLifecycleService.cancelEventWithRefund(
      eventId,
      adminId,
      reason
    );
  }

  getCancellationStatus(eventId: string): Promise<EventCancellationJobDetail> {
    return this.eventLifecycleService.getCancellationStatus(eventId);
  }
}
