import { Module } from "@nestjs/common";
import { TicketService } from "./ticket.service";
import { TicketController } from "./ticket.controller";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { TicketGateway } from "./ticket.gateway";
import { CheckInLog, CheckInLogSchema } from "@src/schemas/checkin-log.schema";
import { UploadService } from "@src/upload/upload.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { GetCheckInHistoryQuery } from "./application/queries/get-check-in-history.query";
import { GetTicketByCodeQuery } from "./application/queries/get-ticket-by-code.query";
import { ListMyTicketsQuery } from "./application/queries/list-my-tickets.query";
import { ListTicketsQuery } from "./application/queries/list-tickets.query";
import { CancelTicketUseCase } from "./application/use-case/cancel-ticket.use-case";
import { CheckInTicketUseCase } from "./application/use-case/check-in-ticket.use-case";
import { GenerateMissingQRCodesUseCase } from "./application/use-case/generate-missing-qrcodes.use-case";
import { IssueTicketsFromBookingUseCase } from "./application/use-case/issue-tickets-from-booking.use-case";
import { ValidateTicketUseCase } from "./application/use-case/validate-ticket.use-case";
import { TicketCacheService } from "./infrastructure/cache/ticket-cache.service";
import { TicketQrService } from "./infrastructure/qr/ticket-qr.service";
import { TicketPublisherService } from "./infrastructure/realtime/ticket-publisher.service";
import { TicketPresenter } from "./presenters/ticket.presenter";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ticket.name, schema: TicketSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Event.name, schema: EventSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: CheckInLog.name, schema: CheckInLogSchema },
    ]),
  ],
  providers: [
    TicketService,
    TicketGateway,
    UploadService,
    EventOwnershipService,
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
  ],
  controllers: [TicketController],
  exports: [TicketService],
})
export class TicketModule {}
