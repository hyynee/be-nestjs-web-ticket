import { Module } from '@nestjs/common';
import { BookingService } from './booking.service';
import { BookingController } from './booking.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { Booking, BookingSchema } from '@src/schemas/booking.schema';
import { Zone, ZoneSchema } from '@src/schemas/zone.schema';
import { EventSchema, Event } from '@src/schemas/event.schema';
import { Area, AreaSchema } from '@src/schemas/area.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Booking.name, schema: BookingSchema }, { name: Event.name, schema: EventSchema }, { name: Zone.name, schema: ZoneSchema },{name: Area.name, schema: AreaSchema}]),
  ],
  controllers: [BookingController],
  providers: [BookingService],
  exports: [BookingService],
})
export class BookingModule { }
