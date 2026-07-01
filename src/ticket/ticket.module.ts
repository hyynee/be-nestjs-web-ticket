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
  providers: [TicketService, TicketGateway, UploadService],
  controllers: [TicketController],
  exports: [TicketService],
})
export class TicketModule {}
