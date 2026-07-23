import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { AuditService } from "@src/audit/audit.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { RedisService } from "@src/redis/redis.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { Event } from "@src/schemas/event.schema";
import { User } from "@src/schemas/user.schema";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import { Model, Types } from "mongoose";
import type { EventUserView, EventView } from "../domain/types/event.types";
import { EventOwnershipService } from "../event-ownership.service";
import { EventCacheService } from "../infrastructure/cache/event-cache.service";
import { EventPresenter } from "../presenters/event.presenter";

@Injectable()
export class EventMemberService {
  private readonly logger = new Logger(EventMemberService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly redisService: RedisService,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly auditService: AuditService,
    private readonly eventCacheService: EventCacheService,
    private readonly reportCacheService: ReportCacheService,
    private readonly eventPresenter: EventPresenter
  ) {}

  /**
   * Organizer report/sales/check-in/refund reports scope organizers by
   * `eventIdIn` (their currently-managed event list) and cache that result
   * for up to a few minutes (see ReportCacheService). Reassigning an
   * organizer changes what that list should be, so it must invalidate the
   * report cache too — otherwise a just-removed organizer (or one just
   * granted a new event) could see stale aggregate numbers until the
   * cache's own TTL expires. Best-effort: never allowed to fail the
   * membership change itself.
   */
  private invalidateReportCacheSafely(context: string): void {
    this.reportCacheService.invalidateAll().catch((error: unknown) => {
      this.logger.warn(
        `invalidateReportCacheSafely failed (${context}): ${this.errorMessage(error)}`
      );
    });
  }

  async addOrganizerToEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<EventView> {
    this.assertValidEventAndUserIds(eventId, targetUserId);
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const session = await this.eventModel.db.startSession();
    let updatedEvent!: Event;
    let promotedRole = false;

    try {
      await session.withTransaction(async () => {
        const event = await this.eventModel
          .findOne({ _id: eventId, isDeleted: false })
          .session(session);
        if (!event) {
          throw new NotFoundException(`Event with ID ${eventId} not found`);
        }

        const isAlreadyManager =
          event.createdBy.toString() === targetUserId ||
          event.organizerIds.some((id) => id.toString() === targetUserId);
        if (isAlreadyManager) {
          throw new BadRequestException(
            "User already manages this event as owner or organizer"
          );
        }

        const targetUser = await this.userModel
          .findById(targetUserId)
          .select("_id role isActive")
          .lean()
          .session(session);
        if (!targetUser) {
          throw new NotFoundException("User not found");
        }
        if (targetUser.isActive === false) {
          throw new BadRequestException(
            "Cannot assign an inactive user as organizer"
          );
        }

        event.organizerIds.push(new Types.ObjectId(targetUserId));
        await event.save({ session });

        if (targetUser.role !== "admin" && targetUser.role !== "organizer") {
          await this.userModel.updateOne(
            { _id: targetUserId },
            { $set: { role: "organizer" } },
            { session }
          );
          promotedRole = true;
        }

        updatedEvent = event;
      });
    } finally {
      await session.endSession();
    }

    if (promotedRole) {
      await this.redisService.client
        .del(`auth:user-state:${targetUserId}`)
        .catch((error: unknown) => {
          this.logger.warn(
            `Failed to invalidate auth state for promoted organizer ${targetUserId}: ${this.errorMessage(error)}`
          );
        });
    }

    await this.eventCacheService.invalidateEventCache(eventId);
    this.invalidateReportCacheSafely("event.organizer_add");
    await this.auditService.record({
      action: AuditAction.EVENT_ORGANIZER_ADD,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      metadata: { targetUserId },
    });

    return this.eventPresenter.toEventView(updatedEvent);
  }

  async removeOrganizerFromEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<EventView> {
    this.assertValidEventAndUserIds(eventId, targetUserId);
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel.findOne({
      _id: eventId,
      isDeleted: false,
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    if (event.createdBy.toString() === targetUserId) {
      throw new BadRequestException(
        "Cannot remove the event owner — transfer ownership is not supported"
      );
    }

    const wasOrganizer = event.organizerIds.some(
      (id) => id.toString() === targetUserId
    );
    if (!wasOrganizer) {
      throw new BadRequestException("User is not an organizer of this event");
    }

    event.organizerIds = event.organizerIds.filter(
      (id) => id.toString() !== targetUserId
    );
    await event.save();
    await this.eventCacheService.invalidateEventCache(eventId);
    this.invalidateReportCacheSafely("event.organizer_remove");
    await this.auditService.record({
      action: AuditAction.EVENT_ORGANIZER_REMOVE,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      metadata: { targetUserId },
    });

    return this.eventPresenter.toEventView(event);
  }

  async getEventStaff(
    currentUser: JwtPayload,
    eventId: string
  ): Promise<EventUserView[]> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel
      .findOne({ _id: eventId, isDeleted: false })
      .select("staffIds")
      .populate("staffIds", "email fullName")
      .lean<{
        staffIds: Array<{
          _id: Types.ObjectId;
          email?: string;
          fullName?: string;
        }>;
      }>();

    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    return (event.staffIds ?? []).map((staff) =>
      this.eventPresenter.toEventUserView(staff)
    );
  }

  async addStaffToEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string,
    notes?: string
  ): Promise<EventView> {
    this.assertValidEventAndUserIds(eventId, targetUserId);
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const session = await this.eventModel.db.startSession();
    let updatedEvent!: Event;
    let promotedRole = false;

    try {
      await session.withTransaction(async () => {
        const event = await this.eventModel
          .findOne({ _id: eventId, isDeleted: false })
          .session(session);
        if (!event) {
          throw new NotFoundException(`Event with ID ${eventId} not found`);
        }

        const isAlreadyStaff = event.staffIds.some(
          (id) => id.toString() === targetUserId
        );
        if (isAlreadyStaff) {
          throw new BadRequestException(
            "User is already check-in staff for this event"
          );
        }

        const targetUser = await this.userModel
          .findById(targetUserId)
          .select("_id role isActive")
          .lean()
          .session(session);
        if (!targetUser) {
          throw new NotFoundException("User not found");
        }
        if (targetUser.isActive === false) {
          throw new BadRequestException(
            "Cannot assign an inactive user as check-in staff"
          );
        }

        event.staffIds.push(new Types.ObjectId(targetUserId));
        await event.save({ session });

        if (targetUser.role === "user") {
          await this.userModel.updateOne(
            { _id: targetUserId },
            { $set: { role: "checkin_staff" } },
            { session }
          );
          promotedRole = true;
        }

        updatedEvent = event;
      });
    } finally {
      await session.endSession();
    }

    if (promotedRole) {
      await this.redisService.client
        .del(`auth:user-state:${targetUserId}`)
        .catch((error: unknown) => {
          this.logger.warn(
            `Failed to invalidate auth state for promoted staff ${targetUserId}: ${this.errorMessage(error)}`
          );
        });
    }

    await this.eventCacheService.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_STAFF_ADD,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      reason: notes,
      metadata: { targetUserId },
    });

    return this.eventPresenter.toEventView(updatedEvent);
  }

  async removeStaffFromEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<EventView> {
    this.assertValidEventAndUserIds(eventId, targetUserId);
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel.findOne({
      _id: eventId,
      isDeleted: false,
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    const wasStaff = event.staffIds.some(
      (id) => id.toString() === targetUserId
    );
    if (!wasStaff) {
      throw new BadRequestException(
        "User is not check-in staff for this event"
      );
    }

    event.staffIds = event.staffIds.filter(
      (id) => id.toString() !== targetUserId
    );
    await event.save();
    await this.eventCacheService.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_STAFF_REMOVE,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      metadata: { targetUserId },
    });

    return this.eventPresenter.toEventView(event);
  }

  private assertValidEventAndUserIds(eventId: string, userId: string): void {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!Types.ObjectId.isValid(userId)) {
      throw new BadRequestException("Invalid user ID");
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }
}
