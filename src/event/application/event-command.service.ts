import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Area } from "@src/schemas/area.schema";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Model, Types } from "mongoose";
import { EventTimeSlotPolicy } from "../domain/policies/event-time-slot.policy";
import { EventPublishPolicy } from "../domain/policies/event-publish.policy";
import type { EventView, RemovedSlotCheck } from "../domain/types/event.types";
import { CreateEventDTO } from "../dto/create-event.dto";
import { UpdateEventDTO } from "../dto/update-event.dto";
import { EventOwnershipService } from "../event-ownership.service";
import { EventCacheService } from "../infrastructure/cache/event-cache.service";
import { EventPresenter } from "../presenters/event.presenter";

@Injectable()
export class EventCommandService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly eventCacheService: EventCacheService,
    private readonly eventPresenter: EventPresenter,
    private readonly eventPublishPolicy: EventPublishPolicy,
    private readonly eventTimeSlotPolicy: EventTimeSlotPolicy
  ) {}

  async createEvent(
    currentUser: JwtPayload,
    eventData: CreateEventDTO
  ): Promise<EventView> {
    this.eventTimeSlotPolicy.validateTimeSlots(
      eventData.timeSlots,
      eventData.startDate,
      eventData.endDate
    );

    const newEvent = new this.eventModel({
      createdBy: new Types.ObjectId(currentUser.userId),
      ...eventData,
    });

    if (eventData.status === EventStatus.ACTIVE) {
      this.eventPublishPolicy.assertEventFieldsPublishable(
        eventData.title,
        eventData.location,
        eventData.startDate,
        eventData.endDate
      );
      await this.eventPublishPolicy.assertInventoryPublishable(
        newEvent._id,
        eventData.endDate
      );
    }

    const saved = await newEvent.save();
    await this.eventCacheService.invalidateEventCache(saved._id.toString());
    return this.eventPresenter.toEventView(saved);
  }

  async updateEvent(
    currentUser: JwtPayload,
    id: string,
    eventData: UpdateEventDTO
  ): Promise<EventView> {
    const existingEvent = await this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .exec();
    if (!existingEvent) {
      throw new NotFoundException(
        `Event with ID ${id} not found or has been deleted`
      );
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, id);

    const effectiveStart = eventData.startDate ?? existingEvent.startDate;
    const effectiveEnd = eventData.endDate ?? existingEvent.endDate;

    if (
      eventData.status !== undefined &&
      eventData.status !== existingEvent.status &&
      (existingEvent.status === EventStatus.ENDED ||
        existingEvent.status === EventStatus.CANCELLED)
    ) {
      throw new BadRequestException(
        `Không thể đổi trạng thái của event đang ở trạng thái "${existingEvent.status}"`
      );
    }

    const targetStatus = eventData.status ?? existingEvent.status;
    if (targetStatus === EventStatus.ACTIVE) {
      this.eventPublishPolicy.assertEventFieldsPublishable(
        eventData.title ?? existingEvent.title,
        eventData.location ?? existingEvent.location,
        effectiveStart,
        effectiveEnd
      );
      await this.eventPublishPolicy.assertInventoryPublishable(
        existingEvent._id,
        effectiveEnd
      );
    }

    if (eventData.timeSlots !== undefined) {
      this.eventTimeSlotPolicy.validateTimeSlots(
        eventData.timeSlots,
        effectiveStart,
        effectiveEnd
      );
      await this.assertRemovedSlotsHaveNoActiveBookings(
        existingEvent,
        eventData
      );
    }

    const updatedEvent = await this.eventModel
      .findByIdAndUpdate(
        id,
        {
          ...eventData,
          ...(eventData.thumbnail === null ? { thumbnail: "" } : {}),
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
        { new: true }
      )
      .exec();

    if (!updatedEvent) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }

    await this.eventCacheService.invalidateEventCache(id);
    return this.eventPresenter.toEventView(updatedEvent);
  }

  async deleteEvent(id: string): Promise<EventView> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid event ID");
    }

    const activeBookings = await this.bookingModel.countDocuments({
      eventId: new Types.ObjectId(id),
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      isDeleted: false,
    });

    if (activeBookings > 0) {
      throw new BadRequestException(
        "Cancel all active bookings before deleting this event"
      );
    }

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

      await this.eventCacheService.invalidateEventCache(id);
      return this.eventPresenter.toEventView(deletedEvent);
    } finally {
      await session.endSession();
    }
  }

  async restoreEvent(id: string): Promise<EventView> {
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

      await this.eventCacheService.invalidateEventCache(id);
      return this.eventPresenter.toEventView(restoredEvent);
    } finally {
      await session.endSession();
    }
  }

  private async assertRemovedSlotsHaveNoActiveBookings(
    existingEvent: Event,
    eventData: UpdateEventDTO
  ): Promise<void> {
    const removedSlotIds = existingEvent.timeSlots
      .filter(
        (existing) =>
          !eventData.timeSlots!.some(
            (incoming) =>
              incoming._id && incoming._id === existing._id.toString()
          )
      )
      .map((s) => s._id);

    if (removedSlotIds.length === 0) {
      return;
    }

    const checks = await Promise.all(
      removedSlotIds.map(async (slotId) => {
        const slot = existingEvent.timeSlots.find((s) => s._id.equals(slotId));
        const count = await this.bookingModel.countDocuments({
          timeSlotId: slotId,
          status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
          isDeleted: false,
        });
        return this.removedSlotCheck(slotId, count, slot);
      })
    );
    const blocked = checks.filter((c) => c.count > 0);
    if (blocked.length === 0) {
      return;
    }

    const details = blocked
      .map((b) => `"${b.label}" (${b.count} vé)`)
      .join(", ");
    throw new BadRequestException(
      `Không thể xóa khung giờ đang có vé đặt: ${details}`
    );
  }

  private removedSlotCheck(
    slotId: Types.ObjectId,
    count: number,
    slot?: { label?: string }
  ): RemovedSlotCheck {
    return { label: slot?.label ?? slotId.toString(), count };
  }
}
