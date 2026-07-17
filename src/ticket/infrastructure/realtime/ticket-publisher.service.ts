import { Injectable } from "@nestjs/common";
import { TicketGateway } from "@src/ticket/ticket.gateway";
import { TicketCacheService } from "@src/ticket/infrastructure/cache/ticket-cache.service";
import { TicketBroadcastItem } from "@src/ticket/types/ticket.types";
import { Types } from "mongoose";

@Injectable()
export class TicketPublisherService {
  constructor(
    private readonly ticketGateway: TicketGateway,
    private readonly ticketCache: TicketCacheService
  ) {}

  async publishTicketCreation(
    bookingCode: string,
    tickets: TicketBroadcastItem[],
    userId?: string
  ): Promise<void> {
    this.ticketGateway.emitTicketCreated({
      bookingCode,
      tickets: tickets.map((ticket) => ({
        ticketCode: ticket.ticketCode,
        eventId: ticket.eventId,
        zoneId: ticket.zoneId,
        seatNumber: ticket.seatNumber || null,
        price: ticket.price,
        status: ticket.status,
      })),
    });

    await this.ticketCache.invalidateTicketCache();
    if (userId) {
      await this.ticketCache.invalidateUserTicketCache(userId);
    }
  }

  emitTicketCheckedIn(ticket: {
    ticketCode: string;
    eventId: Types.ObjectId;
    zoneId: Types.ObjectId;
    seatNumber?: string | null;
    checkedInAt: Date;
  }): void {
    this.ticketGateway.emitTicketCheckedIn({
      ticketCode: ticket.ticketCode,
      eventId: ticket.eventId,
      zoneId: ticket.zoneId,
      seatNumber: ticket.seatNumber || null,
      checkedInAt: ticket.checkedInAt,
    });
  }
}
