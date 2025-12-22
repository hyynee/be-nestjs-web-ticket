import { Module } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketController } from './ticket.controller';
import { Ticket, TicketSchema } from '@src/schemas/ticket.schema';
import { MongooseModule } from '@nestjs/mongoose';
import { Booking, BookingSchema } from '@src/schemas/booking.schema';
import { Event, EventSchema } from '@src/schemas/event.schema';
import { TicketGateway } from './ticket.gateway';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Ticket.name, schema: TicketSchema },
      {name: Booking.name, schema: BookingSchema},
      {name: Event.name, schema: EventSchema}
    ]),
  ],
  providers: [TicketService, TicketGateway],
  controllers: [TicketController],
  exports: [TicketService],
})
export class TicketModule { }
