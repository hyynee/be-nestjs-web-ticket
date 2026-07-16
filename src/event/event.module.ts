import { Module, forwardRef } from "@nestjs/common";
import { EventService } from "./event.service";
import { EventOwnershipService } from "./event-ownership.service";
import { EventScheduler } from "./event.scheduler";
import { EventQueryController } from "./controllers/event-query.controller";
import { EventManagementController } from "./controllers/event-management.controller";
import { EventMemberController } from "./controllers/event-member.controller";
import { EventLifecycleController } from "./controllers/event-lifecycle.controller";
import { EventPublishPolicy } from "./domain/policies/event-publish.policy";
import { EventTimeSlotPolicy } from "./domain/policies/event-time-slot.policy";
import { EventCacheService } from "./infrastructure/cache/event-cache.service";
import { EventRepository } from "./infrastructure/persistence/event.repository";
import { EventPresenter } from "./presenters/event.presenter";
import { EventCommandService } from "./application/event-command.service";
import { EventQueryService } from "./application/event-query.service";
import { EventMemberService } from "./application/event-member.service";
import { EventLifecycleService } from "./application/event-lifecycle.service";
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
  controllers: [
    EventQueryController,
    EventManagementController,
    EventMemberController,
    EventLifecycleController,
  ],
  providers: [
    EventService,
    EventOwnershipService,
    EventScheduler,
    EventCommandService,
    EventQueryService,
    EventMemberService,
    EventLifecycleService,
    EventRepository,
    EventPresenter,
    EventCacheService,
    EventPublishPolicy,
    EventTimeSlotPolicy,
  ],
  exports: [EventService, EventOwnershipService],
})
export class EventModule {}
