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
import { CancelEventBookingsUseCase } from "./application/use-case/cancel-event-bookings.use-case";
import { EventCancellationJobRepository } from "./infrastructure/persistence/event-cancellation-job.repository";
import { EventCancellationPresenter } from "./presenters/event-cancellation.presenter";
import { MongooseModule } from "@nestjs/mongoose";
import { EventSchema } from "@src/schemas/event.schema";
import { UserSchema } from "@src/schemas/user.schema";
import { ZoneSchema } from "@src/schemas/zone.schema";
import { AreaSchema } from "@src/schemas/area.schema";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import {
  EventCancellationJob,
  EventCancellationJobSchema,
} from "@src/schemas/event-cancellation-job.schema";
import { BookingModule } from "@src/booking/booking.module";
import { QueueModule } from "@src/queue/queue.module";
import { ReportModule } from "@src/report/report.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "Event", schema: EventSchema },
      { name: "User", schema: UserSchema },
      { name: "Zone", schema: ZoneSchema },
      { name: "Area", schema: AreaSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: EventCancellationJob.name, schema: EventCancellationJobSchema },
    ]),
    forwardRef(() => BookingModule),
    QueueModule,
    ReportModule,
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
    EventCancellationJobRepository,
    EventCancellationPresenter,
    CancelEventBookingsUseCase,
  ],
  exports: [EventService, EventOwnershipService, CancelEventBookingsUseCase],
})
export class EventModule {}
