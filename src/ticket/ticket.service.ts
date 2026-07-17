import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { ClientSession } from "mongoose";
import { GetCheckInHistoryQuery } from "./application/queries/get-check-in-history.query";
import { GetTicketByCodeQuery } from "./application/queries/get-ticket-by-code.query";
import { ListMyTicketsQuery } from "./application/queries/list-my-tickets.query";
import { ListTicketsQuery } from "./application/queries/list-tickets.query";
import { CancelTicketUseCase } from "./application/use-case/cancel-ticket.use-case";
import { CheckInTicketUseCase } from "./application/use-case/check-in-ticket.use-case";
import { GenerateMissingQRCodesUseCase } from "./application/use-case/generate-missing-qrcodes.use-case";
import { IssueTicketsFromBookingUseCase } from "./application/use-case/issue-tickets-from-booking.use-case";
import { ValidateTicketUseCase } from "./application/use-case/validate-ticket.use-case";
import { MyTicketsQueryDto } from "./dto/my-tickets-query.dto";
import { QueryTicketDto } from "./dto/query.dto";
import { TicketPublisherService } from "./infrastructure/realtime/ticket-publisher.service";
import {
  TicketBroadcastItem,
  TicketCancelResult,
  TicketCheckInHistoryResult,
  TicketCheckInResult,
  TicketDetailLean,
  TicketIssuedItem,
  TicketListItem,
  TicketValidationResult,
} from "./types/ticket.types";

export { validateTimeSlotWindow } from "./domain/policies/ticket-time-slot.policy";
export type {
  TicketBroadcastItem,
  TicketCancelResult,
  TicketCheckInHistoryAdmin,
  TicketCheckInHistoryEntry,
  TicketCheckInHistoryResult,
  TicketCheckInResult,
  TicketDetailLean,
  TicketDetailReference,
  TicketEventAccess,
  TicketEventTitle,
  TicketEventWindow,
  TicketInsertPayload,
  TicketIssuedItem,
  TicketListItem,
  TicketReferenceSource,
  TicketReferenceView,
  TicketSnapshotLean,
  TicketValidationResult,
  TicketViewSource,
  TimeSlotWindow,
  ZoneSeatMode,
} from "./types/ticket.types";

@Injectable()
export class TicketService {
  constructor(
    private readonly ticketPublisher: TicketPublisherService,
    private readonly issueTicketsFromBookingUseCase: IssueTicketsFromBookingUseCase,
    private readonly generateMissingQRCodesUseCase: GenerateMissingQRCodesUseCase,
    private readonly getTicketByCodeQuery: GetTicketByCodeQuery,
    private readonly validateTicketUseCase: ValidateTicketUseCase,
    private readonly checkInTicketUseCase: CheckInTicketUseCase,
    private readonly cancelTicketUseCase: CancelTicketUseCase,
    private readonly listTicketsQuery: ListTicketsQuery,
    private readonly listMyTicketsQuery: ListMyTicketsQuery,
    private readonly getCheckInHistoryQuery: GetCheckInHistoryQuery
  ) {}

  publishTicketCreation(
    bookingCode: string,
    tickets: TicketBroadcastItem[],
    userId?: string
  ): Promise<void> {
    return this.ticketPublisher.publishTicketCreation(
      bookingCode,
      tickets,
      userId
    );
  }

  createTicketsFromBooking(
    bookingCode: string,
    session?: ClientSession,
    requesterUserId?: string
  ): Promise<TicketIssuedItem[]> {
    return this.issueTicketsFromBookingUseCase.execute(
      bookingCode,
      session,
      requesterUserId
    );
  }

  generateMissingQRCodesForBooking(
    bookingCode: string
  ): Promise<TicketIssuedItem[]> {
    return this.generateMissingQRCodesUseCase.execute(bookingCode);
  }

  getTicketByCode(
    userId: string,
    ticketCode: string
  ): Promise<TicketDetailLean> {
    return this.getTicketByCodeQuery.execute(userId, ticketCode);
  }

  validateTicket(
    ticketCode: string,
    currentUser: JwtPayload
  ): Promise<TicketValidationResult> {
    return this.validateTicketUseCase.execute(ticketCode, currentUser);
  }

  checkInTicket(
    ticketCode: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    currentUser: JwtPayload
  ): Promise<TicketCheckInResult> {
    return this.checkInTicketUseCase.execute(
      ticketCode,
      location,
      deviceInfo,
      ipAddress,
      currentUser
    );
  }

  cancelTicket(
    ticketCode: string,
    userId: string
  ): Promise<TicketCancelResult> {
    return this.cancelTicketUseCase.execute(ticketCode, userId);
  }

  getAllTickets(
    query: QueryTicketDto,
    currentUser: JwtPayload
  ): Promise<PaginatedResponse<TicketListItem>> {
    return this.listTicketsQuery.execute(query, currentUser);
  }

  getMyTickets(
    userId: string,
    query: MyTicketsQueryDto
  ): Promise<PaginatedResponse<TicketListItem>> {
    return this.listMyTicketsQuery.execute(userId, query);
  }

  getCheckInHistory(
    ticketCode: string,
    currentUser: JwtPayload
  ): Promise<TicketCheckInHistoryResult> {
    return this.getCheckInHistoryQuery.execute(ticketCode, currentUser);
  }
}
