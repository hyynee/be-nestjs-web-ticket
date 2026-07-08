import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { Area } from "@src/schemas/area.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import config from "@src/config/config";
import { escapeRegex } from "@src/common/utils/regex.utils";
import {
  AvailabilityResult,
  CheckoutContextResult,
  EventSummary,
  GetEventDetailResult,
  SearchEventsArgs,
  SearchEventsResult,
} from "./aicc-tool.types";

const MAX_EVENT_RESULTS = 10;

interface EventLean {
  _id: Types.ObjectId;
  title: string;
  description?: string;
  startDate: Date;
  endDate: Date;
  location: string;
  thumbnail?: string;
  status: EventStatus;
  timeSlots?: Array<{
    _id: Types.ObjectId;
    label: string;
    startTime: Date;
    endTime: Date;
    capacity?: number;
  }>;
}

interface ZoneLean {
  _id: Types.ObjectId;
  name: string;
  price: number;
  capacity: number;
  soldCount: number;
  confirmedSoldCount?: number;
  hasSeating: boolean;
  saleStartDate?: Date;
  saleEndDate?: Date;
}

interface AreaLean {
  _id: Types.ObjectId;
  name: string;
  rowLabel?: string;
  zoneId: Types.ObjectId;
}

@Injectable()
export class AiccEventTool {
  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>
  ) {}

  async searchEvents(args: SearchEventsArgs): Promise<SearchEventsResult> {
    const now = new Date();
    const limit = Math.min(Math.max(args.limit ?? 5, 1), MAX_EVENT_RESULTS);
    const filter: FilterQuery<Event> = { isDeleted: false };

    if (args.status) {
      filter.status = args.status;
    } else {
      filter.status = EventStatus.ACTIVE;
    }

    if (args.dateMode === "active_now") {
      filter.startDate = { $lte: now };
      filter.endDate = { $gte: now };
    } else if (args.dateMode === "upcoming") {
      filter.startDate = { $gt: now };
    }

    if (args.search?.trim()) {
      const regex = new RegExp(escapeRegex(args.search.trim()), "i");
      filter.$or = [
        { title: regex },
        { description: regex },
        { location: regex },
      ];
    }

    const events = (await this.eventModel
      .find(filter)
      .select("title startDate endDate location thumbnail status")
      .sort({ startDate: 1 })
      .limit(limit)
      .lean()
      .exec()) as unknown as EventLean[];

    return { events: events.map((event) => this.toEventSummary(event)) };
  }

  async getEventDetail(eventId: string): Promise<GetEventDetailResult> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("INVALID_EVENT_ID");
    }

    const objectId = new Types.ObjectId(eventId);
    const [event, zones, areas] = await Promise.all([
      this.eventModel
        .findOne({ _id: objectId, isDeleted: false })
        .select(
          "title description startDate endDate location thumbnail status timeSlots"
        )
        .lean()
        .exec(),
      this.zoneModel
        .find({ eventId: objectId, isDeleted: false })
        .select("name price capacity soldCount confirmedSoldCount hasSeating")
        .sort({ price: 1, createdAt: 1 })
        .lean()
        .exec(),
      this.areaModel
        .find({ eventId: objectId, isDeleted: false })
        .select("name rowLabel zoneId")
        .sort({ createdAt: 1 })
        .lean()
        .exec(),
    ]);

    if (!event) {
      throw new NotFoundException("EVENT_NOT_FOUND");
    }

    const typedEvent = event as unknown as EventLean;
    const typedZones = zones as unknown as ZoneLean[];
    const typedAreas = areas as unknown as AreaLean[];
    const areasByZone = new Map<string, AreaLean[]>();
    typedAreas.forEach((area) => {
      const key = area.zoneId.toString();
      areasByZone.set(key, [...(areasByZone.get(key) ?? []), area]);
    });

    return {
      event: {
        ...this.toEventSummary(typedEvent),
        description: typedEvent.description,
        timeSlots: (typedEvent.timeSlots ?? []).map((slot) => ({
          id: slot._id.toString(),
          label: slot.label,
          startTime: slot.startTime.toISOString(),
          endTime: slot.endTime.toISOString(),
          capacity: slot.capacity,
        })),
      },
      zones: typedZones.map((zone) => ({
        id: zone._id.toString(),
        name: zone.name,
        price: zone.price,
        capacity: zone.capacity,
        soldCount: zone.soldCount,
        confirmedSoldCount: zone.confirmedSoldCount ?? 0,
        availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
        hasSeating: zone.hasSeating,
        areas: (areasByZone.get(zone._id.toString()) ?? []).map((area) => ({
          id: area._id.toString(),
          name: area.name,
          rowLabel: area.rowLabel,
        })),
      })),
      bookable: typedEvent.status === EventStatus.ACTIVE,
    };
  }

  async checkTicketAvailability(args: {
    eventId: string;
    zoneId?: string;
  }): Promise<AvailabilityResult> {
    if (!Types.ObjectId.isValid(args.eventId)) {
      throw new BadRequestException("INVALID_EVENT_ID");
    }
    if (args.zoneId && !Types.ObjectId.isValid(args.zoneId)) {
      throw new BadRequestException("INVALID_ZONE_ID");
    }

    const eventObjectId = new Types.ObjectId(args.eventId);
    const event = await this.eventModel
      .findOne({ _id: eventObjectId, isDeleted: false })
      .select("status")
      .lean()
      .exec();
    if (!event) {
      throw new NotFoundException("EVENT_NOT_FOUND");
    }
    if ((event as unknown as EventLean).status !== EventStatus.ACTIVE) {
      return {
        available: false,
        message: "Sự kiện hiện chưa mở bán hoặc không còn bán vé.",
      };
    }

    const zoneFilter: FilterQuery<Zone> = {
      eventId: eventObjectId,
      isDeleted: false,
    };
    if (args.zoneId) {
      zoneFilter._id = new Types.ObjectId(args.zoneId);
    }

    const zones = (await this.zoneModel
      .find(zoneFilter)
      .select("name capacity soldCount")
      .limit(args.zoneId ? 1 : 5)
      .lean()
      .exec()) as unknown as ZoneLean[];

    if (zones.length === 0) {
      throw new NotFoundException("ZONE_NOT_FOUND");
    }

    const totalCapacity = zones.reduce((sum, zone) => sum + zone.capacity, 0);
    const totalSold = zones.reduce((sum, zone) => sum + zone.soldCount, 0);
    const availableTickets = Math.max(totalCapacity - totalSold, 0);

    return {
      available: availableTickets > 0,
      capacity: totalCapacity,
      soldCount: totalSold,
      availableTickets,
      message:
        availableTickets > 0
          ? `Hiện còn khoảng ${availableTickets} vé trong phạm vi bạn chọn.`
          : "Khu vực này hiện đã hết vé.",
    };
  }

  async buildCheckoutContext(args: {
    eventId: string;
    zoneId?: string;
    areaId?: string;
    timeSlotId?: string;
    quantity: number;
  }): Promise<CheckoutContextResult> {
    if (!Types.ObjectId.isValid(args.eventId)) {
      throw new BadRequestException("INVALID_EVENT_ID");
    }
    if (args.zoneId && !Types.ObjectId.isValid(args.zoneId)) {
      throw new BadRequestException("INVALID_ZONE_ID");
    }
    if (args.areaId && !Types.ObjectId.isValid(args.areaId)) {
      throw new BadRequestException("INVALID_AREA_ID");
    }
    if (args.timeSlotId && !Types.ObjectId.isValid(args.timeSlotId)) {
      throw new BadRequestException("INVALID_TIME_SLOT_ID");
    }

    const quantity = Math.min(Math.max(Math.floor(args.quantity), 1), 10);
    const eventObjectId = new Types.ObjectId(args.eventId);
    const event = (await this.eventModel
      .findOne({ _id: eventObjectId, isDeleted: false })
      .select("title status endDate timeSlots")
      .lean()
      .exec()) as unknown as Pick<
      EventLean,
      "_id" | "title" | "status" | "endDate" | "timeSlots"
    > | null;

    const selection = {
      eventId: args.eventId,
      zoneId: args.zoneId,
      areaId: args.areaId,
      timeSlotId: args.timeSlotId,
      quantity,
    };

    if (!event) {
      return {
        canCheckout: false,
        reason: "EVENT_NOT_FOUND",
        selection,
      };
    }

    if (event.status !== EventStatus.ACTIVE || event.endDate < new Date()) {
      return {
        canCheckout: false,
        reason: "EVENT_NOT_BOOKABLE",
        event: { id: args.eventId, title: event.title },
        selection,
      };
    }

    if (
      args.timeSlotId &&
      !(event.timeSlots ?? []).some(
        (slot) => slot._id.toString() === args.timeSlotId
      )
    ) {
      return {
        canCheckout: false,
        reason: "TIME_SLOT_NOT_FOUND",
        event: { id: args.eventId, title: event.title },
        selection,
      };
    }

    const zoneFilter: FilterQuery<Zone> = {
      eventId: eventObjectId,
      isDeleted: false,
    };
    if (args.zoneId) {
      zoneFilter._id = new Types.ObjectId(args.zoneId);
    }

    const zones = (await this.zoneModel
      .find(zoneFilter)
      .select(
        "name price capacity soldCount hasSeating saleStartDate saleEndDate"
      )
      .sort({ price: 1, createdAt: 1 })
      .limit(args.zoneId ? 1 : 5)
      .lean()
      .exec()) as unknown as ZoneLean[];

    const now = new Date();
    const availableZones = zones
      .map((zone) => ({
        zone,
        availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
      }))
      .filter(({ zone, availableTickets }) => {
        const saleStarted = !zone.saleStartDate || zone.saleStartDate <= now;
        const saleOpen = !zone.saleEndDate || zone.saleEndDate >= now;
        return availableTickets >= quantity && saleStarted && saleOpen;
      });

    if (args.zoneId && zones.length === 0) {
      return {
        canCheckout: false,
        reason: "ZONE_NOT_FOUND",
        event: { id: args.eventId, title: event.title },
        selection,
      };
    }

    if (availableZones.length === 0) {
      const suggestedZones = zones
        .map((zone) => ({
          id: zone._id.toString(),
          name: zone.name,
          price: zone.price,
          availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
        }))
        .filter((zone) => zone.availableTickets > 0);

      return {
        canCheckout: false,
        reason: "SOLD_OUT",
        event: { id: args.eventId, title: event.title },
        selection,
        suggestedZones,
      };
    }

    const selectedZone = availableZones[0].zone;
    const selectedZoneId = selectedZone._id.toString();
    const checkoutSelection = {
      ...selection,
      zoneId: selectedZoneId,
    };

    return {
      canCheckout: true,
      event: { id: args.eventId, title: event.title },
      selection: checkoutSelection,
      estimatedTotal: selectedZone.price * quantity,
      checkoutDeepLink: this.buildCheckoutDeepLink(checkoutSelection),
      suggestedZones: availableZones.map(({ zone, availableTickets }) => ({
        id: zone._id.toString(),
        name: zone.name,
        price: zone.price,
        availableTickets,
      })),
    };
  }

  private toEventSummary(event: EventLean): EventSummary {
    return {
      id: event._id.toString(),
      title: event.title,
      startDate: event.startDate.toISOString(),
      endDate: event.endDate.toISOString(),
      location: event.location,
      status: event.status,
      thumbnail: event.thumbnail,
    };
  }

  private buildCheckoutDeepLink(selection: {
    eventId: string;
    zoneId?: string;
    areaId?: string;
    timeSlotId?: string;
    quantity: number;
  }): string {
    const baseUrl = (config.FRONTEND_URL || "").replace(/\/+$/, "");
    const query = new URLSearchParams({
      eventId: selection.eventId,
      quantity: selection.quantity.toString(),
    });

    if (selection.zoneId) {
      query.set("zoneId", selection.zoneId);
    }
    if (selection.areaId) {
      query.set("areaId", selection.areaId);
    }
    if (selection.timeSlotId) {
      query.set("timeSlotId", selection.timeSlotId);
    }

    const path = `/checkout?${query.toString()}`;
    return baseUrl ? `${baseUrl}${path}` : path;
  }
}
