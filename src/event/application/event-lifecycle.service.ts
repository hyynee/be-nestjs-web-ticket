import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { AuditService } from "@src/audit/audit.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BookingService } from "@src/booking/booking.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { FilterQuery, Model, Types } from "mongoose";
import { EventPublishPolicy } from "../domain/policies/event-publish.policy";
import type { EventCancelResult, EventView } from "../domain/types/event.types";
import { CANCEL_BATCH_SIZE } from "../event.constants";
import { EventOwnershipService } from "../event-ownership.service";
import { EventCacheService } from "../infrastructure/cache/event-cache.service";
import { EventPresenter } from "../presenters/event.presenter";

@Injectable()
export class EventLifecycleService {
  private readonly logger = new Logger(EventLifecycleService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly bookingService: BookingService,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly auditService: AuditService,
    private readonly eventCacheService: EventCacheService,
    private readonly eventPresenter: EventPresenter,
    private readonly eventPublishPolicy: EventPublishPolicy
  ) {}

  async publishEvent(
    currentUser: JwtPayload,
    eventId: string
  ): Promise<EventView> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel.findOne({
      _id: eventId,
      isDeleted: false,
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }
    if (
      event.status !== EventStatus.DRAFT &&
      event.status !== EventStatus.INACTIVE
    ) {
      throw new BadRequestException(
        `Không thể publish event đang ở trạng thái "${event.status}"`
      );
    }

    this.eventPublishPolicy.assertEventFieldsPublishable(
      event.title,
      event.location,
      event.startDate,
      event.endDate
    );
    await this.eventPublishPolicy.assertInventoryPublishable(
      event._id,
      event.endDate
    );

    const updated = await this.eventModel.findOneAndUpdate(
      { _id: event._id, isDeleted: false, status: event.status },
      {
        $set: {
          status: EventStatus.ACTIVE,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );
    if (!updated) {
      throw new BadRequestException(
        "Trạng thái event đã thay đổi, vui lòng thử lại"
      );
    }

    await this.eventCacheService.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_PUBLISH,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
    });

    return this.eventPresenter.toEventView(updated);
  }

  async unpublishEvent(
    currentUser: JwtPayload,
    eventId: string
  ): Promise<EventView> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const updated = await this.eventModel.findOneAndUpdate(
      { _id: eventId, isDeleted: false, status: EventStatus.ACTIVE },
      {
        $set: {
          status: EventStatus.INACTIVE,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );
    if (!updated) {
      const exists = await this.eventModel.exists({
        _id: eventId,
        isDeleted: false,
      });
      if (!exists) {
        throw new NotFoundException(`Event with ID ${eventId} not found`);
      }
      throw new BadRequestException(
        "Chỉ có thể unpublish event đang ở trạng thái active"
      );
    }

    await this.eventCacheService.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_UNPUBLISH,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
    });

    return this.eventPresenter.toEventView(updated);
  }

  async endEvent(currentUser: JwtPayload, eventId: string): Promise<EventView> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const updated = await this.eventModel.findOneAndUpdate(
      {
        _id: eventId,
        isDeleted: false,
        status: { $in: [EventStatus.ACTIVE, EventStatus.INACTIVE] },
      },
      {
        $set: {
          status: EventStatus.ENDED,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );
    if (!updated) {
      const exists = await this.eventModel.exists({
        _id: eventId,
        isDeleted: false,
      });
      if (!exists) {
        throw new NotFoundException(`Event with ID ${eventId} not found`);
      }
      throw new BadRequestException(
        "Chỉ có thể kết thúc event đang active hoặc inactive"
      );
    }

    await this.eventCacheService.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_END,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
    });

    return this.eventPresenter.toEventView(updated);
  }

  async cancelEventWithRefund(
    eventId: string,
    adminId: string,
    reason?: string
  ): Promise<EventCancelResult> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const event = await this.eventModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        status: { $nin: [EventStatus.CANCELLED] },
      },
      { $set: { status: EventStatus.CANCELLED } },
      { new: true }
    );

    if (!event) {
      throw new NotFoundException(
        "Event not found, already cancelled, or has been deleted"
      );
    }

    this.logger.log(
      `cancelEventWithRefund: eventId=${eventId} adminId=${adminId} reason="${reason ?? ""}"`
    );

    const cancellationReason = reason ?? "Event cancelled by admin";
    const failed: Array<{ bookingId: string; error: string }> = [];
    let cancelled = 0;
    let lastId: Types.ObjectId | null = null;

    for (;;) {
      const filter: FilterQuery<Booking> = {
        eventId: new Types.ObjectId(eventId),
        status: { $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED] },
        isDeleted: false,
      };
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await this.bookingModel
        .find(filter)
        .select("_id")
        .sort({ _id: 1 })
        .limit(CANCEL_BATCH_SIZE)
        .lean();

      if (!batch.length) {
        break;
      }

      for (const booking of batch) {
        const bookingId = (booking._id as Types.ObjectId).toString();
        try {
          await this.bookingService.adminCancelBooking(
            bookingId,
            adminId,
            cancellationReason
          );
          cancelled++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          this.logger.error(
            `cancelEventWithRefund: failed booking=${bookingId} error="${msg}"`
          );
          failed.push({ bookingId, error: msg });
        }
      }

      lastId = batch[batch.length - 1]._id as Types.ObjectId;
      if (batch.length < CANCEL_BATCH_SIZE) {
        break;
      }
    }

    const totalBookings = cancelled + failed.length;
    this.logger.log(
      `cancelEventWithRefund: done eventId=${eventId} total=${totalBookings} cancelled=${cancelled} failed=${failed.length}`
    );

    return this.eventPresenter.eventCancelResult({
      event,
      totalBookings,
      cancelled,
      failed,
    });
  }
}
