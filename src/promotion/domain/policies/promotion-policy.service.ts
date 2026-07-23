import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { Promotion, PromotionType } from "@src/schemas/promotion.schema";
import { Zone } from "@src/schemas/zone.schema";
import { ClientSession, FilterQuery, Model, Types } from "mongoose";
import { PromotionDocument, ZoneScope } from "../types/promotion-domain.types";
import { PromotionValidationResult } from "../../types/promotion.types";

@Injectable()
export class PromotionPolicyService {
  constructor(
    @InjectModel(Zone.name)
    private readonly zoneModel: Model<Zone>,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  assertPromotionValue(type: PromotionType, value: number): void {
    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(
        "Promotion value must be a positive integer"
      );
    }
    if (type === PromotionType.PERCENT && value > 100) {
      throw new BadRequestException("Percent promotion cannot exceed 100");
    }
  }

  assertPromotionDates(startsAt: Date, endsAt: Date): void {
    if (!(startsAt instanceof Date) || Number.isNaN(startsAt.getTime())) {
      throw new BadRequestException("Invalid promotion start date");
    }
    if (!(endsAt instanceof Date) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestException("Invalid promotion end date");
    }
    if (startsAt >= endsAt) {
      throw new BadRequestException(
        "Promotion start date must be before end date"
      );
    }
  }

  assertPromotionUsable(
    promotion: PromotionDocument,
    eventId: Types.ObjectId,
    zoneId: Types.ObjectId,
    orderAmount: number,
    now: Date
  ): void {
    if (!promotion.isActive) {
      throw new BadRequestException("Promotion is inactive");
    }
    if (now < promotion.startsAt) {
      throw new BadRequestException("Promotion has not started");
    }
    if (now > promotion.endsAt) {
      throw new BadRequestException("Promotion has expired");
    }
    if (
      promotion.eventIds?.length &&
      !promotion.eventIds.some((id) => id.toString() === eventId.toString())
    ) {
      throw new BadRequestException("Promotion does not apply to this event");
    }
    if (
      promotion.zoneIds?.length &&
      !promotion.zoneIds.some((id) => id.toString() === zoneId.toString())
    ) {
      throw new BadRequestException("Promotion does not apply to this zone");
    }
    if (
      typeof promotion.minOrderAmount === "number" &&
      orderAmount < promotion.minOrderAmount
    ) {
      throw new BadRequestException("Order amount is below promotion minimum");
    }
    if (
      typeof promotion.maxUses === "number" &&
      promotion.usedCount >= promotion.maxUses
    ) {
      throw new ConflictException("Promotion usage limit reached");
    }
  }

  async assertCanManagePromotion(
    currentUser: JwtPayload,
    promotion: PromotionDocument
  ): Promise<void> {
    if (currentUser.role === "admin") {
      return;
    }

    const zoneIds = promotion.zoneIds ?? [];
    const zones = zoneIds.length
      ? await this.zoneModel
          .find({ _id: { $in: zoneIds }, isDeleted: false })
          .select("_id eventId")
          .lean<ZoneScope[]>()
      : [];

    const eventScope = new Set(
      (promotion.eventIds ?? []).map((id) => id.toString())
    );
    for (const zone of zones) {
      eventScope.add(zone.eventId.toString());
    }

    if (eventScope.size === 0) {
      throw new ForbiddenException("Only admins can manage global promotions");
    }

    for (const eventId of eventScope) {
      await this.eventOwnershipService.assertCanManageEvent(
        currentUser,
        eventId
      );
    }
  }

  async assertCanManageScope(
    currentUser: JwtPayload,
    eventIds: Types.ObjectId[],
    zoneIds: Types.ObjectId[],
    session?: ClientSession
  ): Promise<void> {
    const zones = zoneIds.length
      ? await this.zoneModel
          .find({ _id: { $in: zoneIds }, isDeleted: false })
          .select("_id eventId")
          .session(session ?? null)
          .lean<ZoneScope[]>()
      : [];
    if (zones.length !== zoneIds.length) {
      throw new NotFoundException("One or more zones were not found");
    }

    const eventScope = new Set(eventIds.map((id) => id.toString()));
    for (const zone of zones) {
      if (eventScope.size > 0 && !eventScope.has(zone.eventId.toString())) {
        throw new BadRequestException(
          "Promotion zone scope must belong to the selected event scope"
        );
      }
      eventScope.add(zone.eventId.toString());
    }

    if (currentUser.role === "admin") {
      return;
    }
    if (eventScope.size === 0) {
      throw new ForbiddenException("Only admins can manage global promotions");
    }

    for (const eventId of eventScope) {
      await this.eventOwnershipService.assertCanManageEvent(
        currentUser,
        eventId,
        session
      );
    }
  }

  async buildManagedFilter(
    currentUser: JwtPayload
  ): Promise<FilterQuery<Promotion>> {
    if (currentUser.role === "admin") {
      return {};
    }

    const managedEventIds =
      await this.eventOwnershipService.getManagedEventIds(currentUser);
    if (!managedEventIds.length) {
      return { _id: { $exists: false } };
    }

    const managedZones = await this.zoneModel
      .find({ eventId: { $in: managedEventIds }, isDeleted: false })
      .select("_id")
      .lean<{ _id: Types.ObjectId }[]>();

    return {
      $or: [
        { eventIds: { $in: managedEventIds } },
        { zoneIds: { $in: managedZones.map((zone) => zone._id) } },
      ],
    };
  }

  async assertZoneBelongsToEvent(
    zoneId: Types.ObjectId,
    eventId: Types.ObjectId,
    session?: ClientSession
  ): Promise<void> {
    const zone = await this.zoneModel
      .findOne({ _id: zoneId, eventId, isDeleted: false })
      .select("_id")
      .session(session ?? null)
      .lean();
    if (!zone) {
      throw new BadRequestException("Zone does not belong to this event");
    }
  }

  buildAtomicUsageFilter(
    promotionId: Types.ObjectId,
    quote: PromotionValidationResult
  ): FilterQuery<Promotion> {
    return {
      _id: promotionId,
      isActive: true,
      startsAt: { $lte: new Date() },
      endsAt: { $gte: new Date() },
      type: quote.type,
      value: quote.value,
      $or: [
        { maxUses: { $exists: false } },
        { maxUses: null },
        { $expr: { $lt: ["$usedCount", "$maxUses"] } },
      ],
    };
  }

  calculateDiscount(
    orderAmount: number,
    type: PromotionType,
    value: number
  ): number {
    if (type === PromotionType.PERCENT) {
      return Math.min(Math.floor((orderAmount * value) / 100), orderAmount);
    }
    return Math.min(value, orderAmount);
  }

  toObjectIds(values: string[], label: string): Types.ObjectId[] {
    return values.map((value) => this.toObjectId(value, `Invalid ${label}`));
  }

  toObjectId(value: string, message: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(message);
    }
    return new Types.ObjectId(value);
  }

  normalizeCode(code: string): string {
    const normalized = code.trim().toUpperCase();
    if (!normalized) {
      throw new BadRequestException("Promotion code is required");
    }
    return normalized;
  }
}
