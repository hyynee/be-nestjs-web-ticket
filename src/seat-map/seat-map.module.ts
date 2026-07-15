import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { SeatMapService } from "./seat-map.service";
import {
  EventSeatMapController,
  ZoneSeatMapController,
  SeatMapController,
} from "./seat-map.controller";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import {
  Booking,
  BookingSchema,
  SeatLock,
  SeatLockSchema,
} from "@src/schemas/booking.schema";
import { SeatState, SeatStateSchema } from "@src/schemas/seat-state.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { ZoneModule } from "@src/zone/zone.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Zone.name, schema: ZoneSchema },
      { name: Area.name, schema: AreaSchema },
      { name: Event.name, schema: EventSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: SeatLock.name, schema: SeatLockSchema },
      { name: SeatState.name, schema: SeatStateSchema },
    ]),
    ZoneModule,
  ],
  controllers: [
    EventSeatMapController,
    ZoneSeatMapController,
    SeatMapController,
  ],
  providers: [SeatMapService, EventOwnershipService],
  exports: [SeatMapService],
})
export class SeatMapModule {}
