import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { ClientSession, Model, Types } from "mongoose";
import { Event } from "@src/schemas/event.schema";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";

type OwnershipCheckFields = {
  _id: Types.ObjectId;
  createdBy: Types.ObjectId;
  organizerIds: Types.ObjectId[];
};

type CheckInAccessFields = {
  createdBy: Types.ObjectId;
  organizerIds?: Types.ObjectId[];
  staffIds?: Types.ObjectId[];
};

/**
 * Central place to answer "can this user manage this event". Kept independent
 * from EventService (which has heavier dependencies like BookingService) so
 * zone/area/booking/ticket/statistical/export modules can use it without
 * pulling in the full event module graph.
 */
@Injectable()
export class EventOwnershipService {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>
  ) {}

  private isManager(event: OwnershipCheckFields, userId: string): boolean {
    const isOwner = event.createdBy?.toString() === userId;
    const isOrganizer = (event.organizerIds ?? []).some(
      (id) => id.toString() === userId
    );
    return isOwner || isOrganizer;
  }

  /**
   * Throws if `user` cannot manage the given event. Admins always pass
   * without a DB lookup. Use this at the top of each event-scoped mutation
   * or admin-facing read that organizers should only see for their own events.
   */
  async assertCanManageEvent(
    user: JwtPayload,
    eventId: string,
    session?: ClientSession
  ): Promise<void> {
    if (user.role === "admin") return;

    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const event = await this.eventModel
      .findOne({ _id: eventId, isDeleted: false })
      .select("createdBy organizerIds")
      .lean<OwnershipCheckFields>()
      .session(session ?? null);

    if (!event) {
      throw new NotFoundException("Event not found");
    }

    if (!this.isManager(event, user.userId)) {
      throw new ForbiddenException(
        "You do not have permission to manage this event"
      );
    }
  }

  /**
   * IDs of non-deleted events the user owns or is assigned as organizer.
   * Returns an empty array for admins — callers must treat that as "no scoping
   * needed" for admin (checked separately), not as "manages nothing".
   */
  async getManagedEventIds(user: JwtPayload): Promise<Types.ObjectId[]> {
    if (user.role === "admin") return [];

    const userObjectId = new Types.ObjectId(user.userId);
    const events = await this.eventModel
      .find({
        isDeleted: false,
        $or: [{ createdBy: userObjectId }, { organizerIds: userObjectId }],
      })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>();

    return events.map((e) => e._id);
  }

  /**
   * Pure/synchronous check for "can this user validate or check in tickets for
   * this event" — admin, the event owner/organizer, or an assigned
   * `checkin_staff`. Takes the event's ownership/staff fields directly (no DB
   * lookup) so callers that already loaded the event (e.g. via a ticket's
   * populated `eventId`) don't pay for a second round trip.
   */
  hasCheckInAccess(user: JwtPayload, event: CheckInAccessFields): boolean {
    if (user.role === "admin") return true;

    const isOwner = event.createdBy?.toString() === user.userId;
    const isOrganizer = (event.organizerIds ?? []).some(
      (id) => id.toString() === user.userId
    );
    const isStaff = (event.staffIds ?? []).some(
      (id) => id.toString() === user.userId
    );

    return isOwner || isOrganizer || isStaff;
  }
}
