import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { Booking, BookingSchema } from '@src/schemas/booking.schema';
import { Zone, ZoneSchema } from '@src/schemas/zone.schema';
import { EventSchema, Event } from '@src/schemas/event.schema';
import { Area, AreaSchema } from '@src/schemas/area.schema';
import {Ticket,TicketSchema} from '@src/schemas/ticket.schema'
import { BookingScheduler } from './booking.scheduler';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema }, 
      { name: Event.name, schema: EventSchema }, { name: Zone.name, schema: ZoneSchema },
      {name: Area.name, schema: AreaSchema},
      {name: Ticket.name,schema: TicketSchema}
    ]),
  ],
  controllers: [BookingController],
  providers: [BookingService,BookingScheduler],
  exports: [BookingService],
})
export class BookingModule { }
