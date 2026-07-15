import { Module } from "@nestjs/common";
import { AreaService } from "./area.service";
import { AreaController } from "./area.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Area.name, schema: AreaSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [AreaController],
  providers: [AreaService, EventOwnershipService],
})
export class AreaModule {}
