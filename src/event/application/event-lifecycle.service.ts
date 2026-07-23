import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { AuditService } from "@src/audit/audit.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { QueueService } from "@src/queue/queue.service";
import { EVENT_CANCELLATION_JOB_TYPE } from "@src/queue/queue.constants";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Model, Types } from "mongoose";
import { EventPublishPolicy } from "../domain/policies/event-publish.policy";
import type { EventCancellationJobDetail } from "../domain/types/event-cancellation.types";
import type { EventView } from "../domain/types/event.types";
import { EventOwnershipService } from "../event-ownership.service";
import { EventCacheService } from "../infrastructure/cache/event-cache.service";
import { EventCancellationJobRepository } from "../infrastructure/persistence/event-cancellation-job.repository";
import { EventCancellationPresenter } from "../presenters/event-cancellation.presenter";
import { EventPresenter } from "../presenters/event.presenter";

@Injectable()
export class EventLifecycleService {
  private readonly logger = new Logger(EventLifecycleService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly auditService: AuditService,
    private readonly eventCacheService: EventCacheService,
    private readonly eventPresenter: EventPresenter,
    private readonly eventPublishPolicy: EventPublishPolicy,
    private readonly queueService: QueueService,
    private readonly cancellationJobRepository: EventCancellationJobRepository,
    private readonly cancellationPresenter: EventCancellationPresenter
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

  /**
   * Flips the event to CANCELLED and hands the actual bulk refund/cancel
   * work off to a queue job (production-readiness-audit-2026-07-22.md
   * NEW#6) — MUST NOT loop over bookings calling the payment provider on
   * this HTTP request thread; a sold-out event can have thousands of
   * bookings, guaranteeing a request timeout under the old synchronous
   * design. Returns immediately with a job handle; poll
   * getCancellationStatus(eventId) for progress.
   */
  async cancelEventWithRefund(
    eventId: string,
    adminId: string,
    reason?: string
  ): Promise<EventCancellationJobDetail> {
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

    const cancellationReason = reason ?? "Event cancelled by admin";
    const totalBookings = await this.bookingModel.countDocuments({
      eventId: event._id,
      status: { $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED] },
      isDeleted: false,
    });

    const cancellationJobId = new Types.ObjectId();
    const queueJobId = `cancel-event-bookings-${cancellationJobId.toString()}`;

    const job = await this.cancellationJobRepository.create({
      id: cancellationJobId,
      eventId: event._id as Types.ObjectId,
      initiatedBy: new Types.ObjectId(adminId),
      reason: cancellationReason,
      totalBookings,
      queueJobId,
    });

    await this.queueService.addJob(
      {
        type: EVENT_CANCELLATION_JOB_TYPE,
        payload: { cancellationJobId: cancellationJobId.toString() },
      },
      { jobId: queueJobId }
    );

    await this.eventCacheService.invalidateEventCache(eventId);

    await this.auditService.record({
      action: AuditAction.EVENT_CANCEL,
      actorId: adminId,
      actorRole: "admin",
      eventId,
      reason: cancellationReason,
      metadata: {
        totalBookings,
        cancellationJobId: cancellationJobId.toString(),
      },
    });

    this.logger.log(
      `cancelEventWithRefund: eventId=${eventId} adminId=${adminId} totalBookings=${totalBookings} cancellationJobId=${cancellationJobId.toString()} — enqueued, not processed inline`
    );

    return this.cancellationPresenter.toDetail(job);
  }

  async getCancellationStatus(
    eventId: string
  ): Promise<EventCancellationJobDetail> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const job =
      await this.cancellationJobRepository.loadLatestForEvent(eventId);
    if (!job) {
      throw new NotFoundException("No cancellation job found for this event");
    }

    return this.cancellationPresenter.toDetail(job);
  }
}
