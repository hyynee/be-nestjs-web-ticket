import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { Booking } from "@src/schemas/booking.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import {
  AiccSensitiveLookupAccess,
  TicketLookupResult,
} from "./aicc-tool.types";

interface PopulatedTicketLean {
  _id: Types.ObjectId;
  ticketCode: string;
  status: string;
  checkedInAt?: Date;
  seatNumber?: string;
  eventId?: {
    _id: Types.ObjectId;
    title: string;
    startDate: Date;
    endDate: Date;
    location: string;
    status?: string;
    thumbnail?: string;
  };
  zoneId?: { _id: Types.ObjectId; name: string };
  areaId?: { _id: Types.ObjectId; name: string };
  bookingId?: { _id: Types.ObjectId; bookingCode: string };
}

@Injectable()
export class AiccTicketTool {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>
  ) {}

  async lookupTicket(args: {
    ticketCode?: string;
    bookingCode?: string;
    access?: AiccSensitiveLookupAccess;
  }): Promise<TicketLookupResult> {
    const filter: FilterQuery<Ticket> = { isDeleted: false };
    if (!this.hasAccess(args.access)) {
      return { found: false };
    }

    if (args.ticketCode) {
      filter.ticketCode = args.ticketCode.trim().toUpperCase();
      if (args.access?.userId && Types.ObjectId.isValid(args.access.userId)) {
        filter.userId = new Types.ObjectId(args.access.userId);
      }
    } else if (args.bookingCode) {
      const booking = await this.bookingModel
        .findOne({
          bookingCode: args.bookingCode.trim().toUpperCase(),
          isDeleted: false,
          ...this.buildBookingAccessFilter(args.access),
        })
        .select("_id")
        .lean()
        .exec();
      if (!booking) {
        return { found: false };
      }
      filter.bookingId = (booking as { _id: Types.ObjectId })._id;
    } else {
      return { found: false };
    }

    const ticket = (await this.ticketModel
      .findOne(filter)
      .select(
        "ticketCode status checkedInAt seatNumber eventId zoneId areaId bookingId"
      )
      .sort({ createdAt: -1 })
      .populate("eventId", "title startDate endDate location thumbnail status")
      .populate("zoneId", "name")
      .populate("areaId", "name")
      .populate("bookingId", "bookingCode")
      .lean()
      .exec()) as unknown as PopulatedTicketLean | null;

    if (!ticket) {
      return { found: false };
    }

    if (!args.access?.userId) {
      const booking = await this.bookingModel
        .findOne({
          _id: ticket.bookingId?._id ?? ticket.bookingId,
          isDeleted: false,
          ...this.buildBookingAccessFilter(args.access),
        })
        .select("_id")
        .lean()
        .exec();
      if (!booking) {
        return { found: false };
      }
    }

    return {
      found: true,
      ticket: {
        id: ticket._id.toString(),
        ticketCode: ticket.ticketCode,
        status: ticket.status,
        checkedInAt: ticket.checkedInAt?.toISOString(),
        seatNumber: ticket.seatNumber,
        event: ticket.eventId
          ? {
              id: ticket.eventId._id.toString(),
              title: ticket.eventId.title,
              startDate: ticket.eventId.startDate.toISOString(),
              endDate: ticket.eventId.endDate.toISOString(),
              location: ticket.eventId.location,
              status: ticket.eventId.status ?? "",
              thumbnail: ticket.eventId.thumbnail,
            }
          : undefined,
        zone: ticket.zoneId
          ? { id: ticket.zoneId._id.toString(), name: ticket.zoneId.name }
          : undefined,
        area: ticket.areaId
          ? { id: ticket.areaId._id.toString(), name: ticket.areaId.name }
          : undefined,
        bookingCode: ticket.bookingId?.bookingCode,
      },
    };
  }

  private hasAccess(access?: AiccSensitiveLookupAccess): boolean {
    return Boolean(access?.userId && Types.ObjectId.isValid(access.userId));
  }

  private buildBookingAccessFilter(
    access?: AiccSensitiveLookupAccess
  ): FilterQuery<Booking> {
    if (access?.userId && Types.ObjectId.isValid(access.userId)) {
      return { userId: new Types.ObjectId(access.userId) };
    }
    return { _id: { $exists: false } };
  }
}
