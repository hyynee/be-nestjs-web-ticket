import { BadRequestException, Injectable } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { EventStatus } from "@src/schemas/event.schema";
import { Types } from "mongoose";
import type {
  EventCancelResult,
  EventPrincipalSource,
  EventTimeSlotSource,
  EventTimeSlotView,
  EventUserView,
  EventView,
  EventViewSource,
} from "../domain/types/event.types";

@Injectable()
export class EventPresenter {
  getEventId(event: EventViewSource): string {
    const id = event._id?.toString() ?? event.id;
    if (!id) {
      throw new BadRequestException("Event ID is missing");
    }
    return id;
  }

  toEventUserView(user: EventPrincipalSource): EventUserView {
    if (typeof user === "string" || user instanceof Types.ObjectId) {
      return { id: user.toString() };
    }

    const id = user._id?.toString() ?? user.id;
    if (!id) {
      throw new BadRequestException("User ID is missing");
    }

    return {
      id,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
    };
  }

  toEventTimeSlotView(slot: EventTimeSlotSource): EventTimeSlotView {
    const id = slot._id?.toString() ?? slot.id;
    if (!id) {
      throw new BadRequestException("Time slot ID is missing");
    }

    return {
      id,
      label: slot.label,
      startTime: slot.startTime,
      endTime: slot.endTime,
      capacity: slot.capacity,
    };
  }

  toEventView(event: EventViewSource): EventView {
    const now = new Date();

    return {
      id: this.getEventId(event),
      title: event.title,
      description: event.description,
      startDate: event.startDate,
      endDate: event.endDate,
      location: event.location,
      thumbnail: event.thumbnail,
      status: event.status,
      timeSlots: (event.timeSlots ?? []).map((slot) =>
        this.toEventTimeSlotView(slot)
      ),
      createdBy: event.createdBy
        ? this.toEventUserView(event.createdBy)
        : undefined,
      organizerIds: (event.organizerIds ?? []).map(
        (user) => this.toEventUserView(user).id
      ),
      staffIds: (event.staffIds ?? []).map(
        (user) => this.toEventUserView(user).id
      ),
      createdAt: event.createdAt,
      updatedAt: event.updatedAt,
      isActiveNow:
        event.status === EventStatus.ACTIVE &&
        now >= event.startDate &&
        now <= event.endDate,
    };
  }

  toEventPage(
    events: EventViewSource[],
    page: number,
    limit: number,
    total: number
  ): PaginatedResponse<EventView> {
    const totalPages = Math.ceil(total / limit);
    return {
      items: events.map((event) => this.toEventView(event)),
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

  eventCancelResult(input: {
    event: EventViewSource;
    totalBookings: number;
    cancelled: number;
    failed: Array<{ bookingId: string; error: string }>;
  }): EventCancelResult {
    return {
      event: this.toEventView(input.event),
      totalBookings: input.totalBookings,
      cancelled: input.cancelled,
      failed: input.failed,
    };
  }
}
