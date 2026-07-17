import { Provider } from "@nestjs/common";
import { GetCheckInHistoryQuery } from "../application/queries/get-check-in-history.query";
import { GetTicketByCodeQuery } from "../application/queries/get-ticket-by-code.query";
import { ListMyTicketsQuery } from "../application/queries/list-my-tickets.query";
import { ListTicketsQuery } from "../application/queries/list-tickets.query";
import { CancelTicketUseCase } from "../application/use-case/cancel-ticket.use-case";
import { CheckInTicketUseCase } from "../application/use-case/check-in-ticket.use-case";
import { GenerateMissingQRCodesUseCase } from "../application/use-case/generate-missing-qrcodes.use-case";
import { IssueTicketsFromBookingUseCase } from "../application/use-case/issue-tickets-from-booking.use-case";
import { ValidateTicketUseCase } from "../application/use-case/validate-ticket.use-case";
import { TicketCacheService } from "../infrastructure/cache/ticket-cache.service";
import { TicketQrService } from "../infrastructure/qr/ticket-qr.service";
import { TicketPublisherService } from "../infrastructure/realtime/ticket-publisher.service";
import { TicketPresenter } from "../presenters/ticket.presenter";
import { TicketService } from "../ticket.service";

export const ticketTestProviders: Provider[] = [
  TicketService,
  TicketPresenter,
  TicketCacheService,
  TicketQrService,
  TicketPublisherService,
  IssueTicketsFromBookingUseCase,
  GenerateMissingQRCodesUseCase,
  GetTicketByCodeQuery,
  ValidateTicketUseCase,
  CheckInTicketUseCase,
  CancelTicketUseCase,
  ListTicketsQuery,
  ListMyTicketsQuery,
  GetCheckInHistoryQuery,
];
