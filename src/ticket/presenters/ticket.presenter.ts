import { BadRequestException, Injectable } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { Ticket } from "@src/schemas/ticket.schema";
import {
  TicketCancelResult,
  TicketCheckInHistoryEntry,
  TicketCheckInHistoryResult,
  TicketCheckInResult,
  TicketIssuedItem,
  TicketListItem,
  TicketReferenceSource,
  TicketReferenceView,
  TicketValidationResult,
  TicketViewSource,
} from "@src/ticket/types/ticket.types";
import { Types } from "mongoose";

@Injectable()
export class TicketPresenter {
  toTicketReference(
    value: TicketReferenceSource | undefined
  ): TicketReferenceView | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === "string" || value instanceof Types.ObjectId) {
      return { id: value.toString() };
    }

    const id = value._id?.toString() ?? value.id;
    if (!id) {
      return undefined;
    }

    return {
      id,
      title: value.title,
      name: value.name,
      email: value.email,
      fullName: value.fullName,
      bookingCode: value.bookingCode,
      startDate: value.startDate,
      endDate: value.endDate,
      location: value.location,
    };
  }

  toTicketListItem(ticket: TicketViewSource): TicketListItem {
    return {
      id: this.getTicketId(ticket),
      ticketCode: ticket.ticketCode,
      booking: this.toTicketReference(ticket.bookingId),
      user: this.toTicketReference(ticket.userId),
      event: this.toTicketReference(ticket.eventId),
      zone: this.toTicketReference(ticket.zoneId),
      area: this.toTicketReference(ticket.areaId),
      timeSlotId: ticket.timeSlotId?.toString(),
      seatNumber: ticket.seatNumber,
      price: ticket.price,
      status: ticket.status,
      checkedInAt: ticket.checkedInAt,
      checkedInBy: this.toTicketReference(ticket.checkedInBy),
      checkInLocation: ticket.checkInLocation,
      cancelledAt: ticket.cancelledAt,
      cancelledBy: this.toTicketReference(ticket.cancelledBy),
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt,
    };
  }

  toTicketIssuedItem(ticket: TicketViewSource): TicketIssuedItem {
    return {
      ...this.toTicketListItem(ticket),
      qrCode: ticket.qrCode,
    };
  }

  toOptionalTicketListItem(
    ticket: TicketViewSource
  ): TicketListItem | undefined {
    const id = ticket._id?.toString() ?? ticket.id ?? ticket.ticketCode;
    if (!id) {
      return undefined;
    }

    return this.toTicketListItem(ticket);
  }

  ticketValidation(
    valid: boolean,
    message?: string,
    extra: Pick<TicketValidationResult, "usedAt" | "ticket"> = {}
  ): TicketValidationResult {
    return {
      valid,
      message,
      ...extra,
    };
  }

  ticketCheckInResult(ticket: TicketViewSource): TicketCheckInResult {
    return {
      success: true,
      message: "Ticket checked in successfully",
      ticket: this.toTicketIssuedItem(ticket),
    };
  }

  ticketCancelResult(ticketCode: string, ticket: Ticket): TicketCancelResult {
    return {
      success: true,
      message: "Ticket with code " + ticketCode + " cancelled successfully",
      ticket: {
        ticketCode: ticket.ticketCode,
        seatNumber: ticket.seatNumber,
        zoneId: ticket.zoneId.toString(),
        areaId: ticket.areaId?.toString() ?? null,
      },
    };
  }

  ticketPage(
    tickets: TicketViewSource[],
    page: number,
    limit: number,
    total: number
  ): PaginatedResponse<TicketListItem> {
    const totalPages = Math.ceil(total / limit);
    return {
      items: tickets.map((ticket) => this.toTicketListItem(ticket)),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  checkInHistoryResult(
    ticketCode: string,
    eventTitle: string,
    history: TicketCheckInHistoryEntry[]
  ): TicketCheckInHistoryResult {
    return { ticketCode, eventTitle, history };
  }

  private getTicketId(ticket: TicketViewSource): string {
    const id = ticket._id?.toString() ?? ticket.id ?? ticket.ticketCode;
    if (!id) {
      throw new BadRequestException("Ticket ID is missing");
    }
    return id;
  }
}
