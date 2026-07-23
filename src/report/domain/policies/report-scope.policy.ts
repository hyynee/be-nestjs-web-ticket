import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { Zone } from "@src/schemas/zone.schema";

export interface ReportEventScope {
  eventIdEq?: Types.ObjectId;
  eventIdIn?: Types.ObjectId[];
}

type ZoneEventLean = { eventId: Types.ObjectId };

/**
 * Resolves which event(s) a report query is allowed to read.
 *
 * - Admin with no eventId/zoneId filter: unrestricted (`{}`).
 * - Organizer with no eventId/zoneId filter: restricted to events they
 *   manage via `eventIdIn` (an empty array is valid and correctly matches
 *   zero documents through `$in: []`, not "no filter").
 * - Any explicit eventId/zoneId: ownership is re-checked for that specific
 *   resource regardless of role (admin bypasses inside
 *   `assertCanManageEvent`), per rule.md 5.3 "Authorization MUST được
 *   re-check khi state/resource có thể thay đổi".
 */
@Injectable()
export class ReportScopePolicy {
  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  async resolveEventScope(
    user: JwtPayload,
    eventId?: string,
    zoneId?: string
  ): Promise<ReportEventScope> {
    const effectiveEventId = await this.resolveEffectiveEventId(
      eventId,
      zoneId
    );

    if (effectiveEventId) {
      await this.eventOwnershipService.assertCanManageEvent(
        user,
        effectiveEventId
      );
      return { eventIdEq: new Types.ObjectId(effectiveEventId) };
    }

    if (user.role === "admin") return {};

    const managedIds =
      await this.eventOwnershipService.getManagedEventIds(user);
    return { eventIdIn: managedIds };
  }

  /**
   * IDs of events the target organizer manages, after verifying the caller
   * may view that organizer's report (admin, or the organizer viewing their
   * own id).
   */
  async resolveOrganizerScope(
    user: JwtPayload,
    organizerId: string
  ): Promise<Types.ObjectId[]> {
    if (!Types.ObjectId.isValid(organizerId)) {
      throw new BadRequestException("Invalid organizer ID");
    }

    if (user.role !== "admin" && user.userId !== organizerId) {
      throw new ForbiddenException(
        "You can only view your own organizer report"
      );
    }

    return this.eventOwnershipService.getManagedEventIdsForOrganizer(
      organizerId
    );
  }

  private async resolveEffectiveEventId(
    eventId?: string,
    zoneId?: string
  ): Promise<string | undefined> {
    if (!zoneId) return eventId;

    const zone = await this.zoneModel
      .findById(zoneId)
      .select("eventId")
      .lean<ZoneEventLean>();

    if (!zone) {
      throw new NotFoundException("Zone not found");
    }

    const zoneEventId = zone.eventId.toString();
    if (eventId && eventId !== zoneEventId) {
      throw new BadRequestException(
        "zoneId does not belong to the given eventId"
      );
    }

    return zoneEventId;
  }
}
