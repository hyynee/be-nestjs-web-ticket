import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Ticket } from "@src/schemas/ticket.schema";
import { TicketDetailLean } from "@src/ticket/types/ticket.types";
import { Model, Types } from "mongoose";

@Injectable()
export class GetTicketByCodeQuery {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>
  ) {}

  async execute(userId: string, ticketCode: string): Promise<TicketDetailLean> {
    if (!userId) {
      throw new BadRequestException(
        "User ID is required to get ticket details"
      );
    }
    const ticket = await this.ticketModel
      .findOne({
        ticketCode,
        isDeleted: false,
        userId: new Types.ObjectId(userId),
      })
      .populate("eventId", "title location startDate endDate")
      .populate("zoneId", "name")
      .populate("areaId", "name")
      .populate("bookingId", "snapshot")
      .lean<TicketDetailLean>()
      .exec();
    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    return this.applyTicketSnapshot(ticket);
  }

  private applyTicketSnapshot(ticket: TicketDetailLean): TicketDetailLean {
    const snapshot =
      ticket.bookingId &&
      typeof ticket.bookingId === "object" &&
      "snapshot" in ticket.bookingId
        ? ticket.bookingId.snapshot
        : undefined;

    if (!snapshot) {
      return ticket;
    }

    const eventId =
      ticket.eventId && typeof ticket.eventId === "object"
        ? {
            ...ticket.eventId,
            title: snapshot.eventTitle,
            location: snapshot.location,
            startDate: snapshot.eventStartDate,
            endDate: snapshot.eventEndDate,
          }
        : ticket.eventId;

    const zoneId =
      ticket.zoneId && typeof ticket.zoneId === "object"
        ? { ...ticket.zoneId, name: snapshot.zoneName }
        : ticket.zoneId;

    const areaId =
      snapshot.areaName && ticket.areaId && typeof ticket.areaId === "object"
        ? { ...ticket.areaId, name: snapshot.areaName }
        : ticket.areaId;

    return {
      ...ticket,
      eventId,
      zoneId,
      areaId,
    };
  }
}
