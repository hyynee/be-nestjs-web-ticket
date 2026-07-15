import { Module, forwardRef } from "@nestjs/common";
import { EventService } from "./event.service";
import { EventOwnershipService } from "./event-ownership.service";
import { EventScheduler } from "./event.scheduler";
import { EventController } from "./event.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { EventSchema } from "@src/schemas/event.schema";
import { UserSchema } from "@src/schemas/user.schema";
import { ZoneSchema } from "@src/schemas/zone.schema";
import { AreaSchema } from "@src/schemas/area.schema";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { BookingModule } from "@src/booking/booking.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Event", schema: EventSchema },
      { name: "User", schema: UserSchema },
      { name: "Zone", schema: ZoneSchema },
      { name: "Area", schema: AreaSchema },
      { name: Booking.name, schema: BookingSchema },
    ]),
    forwardRef(() => BookingModule),
  ],
  controllers: [EventController],
  providers: [EventService, EventOwnershipService, EventScheduler],
  exports: [EventService, EventOwnershipService],
})
export class EventModule {}
