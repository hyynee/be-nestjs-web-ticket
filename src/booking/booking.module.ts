import { Module } from "@nestjs/common";
import { BookingService } from "./booking.service";
import { BookingAdminController } from "./controllers/booking-admin.controller";
import { BookingCommandController } from "./controllers/booking-command.controller";
import { BookingQueryController } from "./controllers/booking-query.controller";
import { MongooseModule } from "@nestjs/mongoose";
import {
  Booking,
  BookingSchema,
  SeatLock,
  SeatLockSchema,
} from "@src/schemas/booking.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { EventSchema, Event } from "@src/schemas/event.schema";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { SeatState, SeatStateSchema } from "@src/schemas/seat-state.schema";
import { BookingScheduler } from "./booking.scheduler";
import { ZoneModule } from "@src/zone/zone.module";
import { PaymentModule } from "@src/payment/payment.module";
import { UploadModule } from "@src/upload/upload.module";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { BookingWorkflowService } from "./application/booking-workflow.service";
import { BookingCommandService } from "./application/booking-command.service";
import { BookingMutationService } from "./application/use-case/booking-mutation.use-case";
import { CreateBookingUseCase } from "./application/use-case/create-booking.use-case";
import { CancelBookingUseCase } from "./application/use-case/cancel-booking.use-case";
import { AdminCancelBookingUseCase } from "./application/use-case/admin-cancel-booking.use-case";
import { BookingQueryService } from "./application/booking-query.service";
import { BookingMaintenanceService } from "./application/booking-maintenance.service";
import { BookingCacheService } from "./infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "./infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "./presenters/booking.presenter";
import { BookingCodeService } from "./domain/services/booking-code.service";
import { NotificationModule } from "@src/notification/notification.module";
import { PromotionModule } from "@src/promotion/promotion.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: SeatLock.name, schema: SeatLockSchema },
      { name: Event.name, schema: EventSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Area.name, schema: AreaSchema },
      { name: Ticket.name, schema: TicketSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: SeatState.name, schema: SeatStateSchema },
    ]),
    ZoneModule,
    PaymentModule,
    UploadModule,
    NotificationModule,
    PromotionModule,
  ],
  controllers: [
    BookingAdminController,
    BookingCommandController,
    BookingQueryController,
  ],
  providers: [
    BookingService,
    BookingCommandService,
    BookingMutationService,
    CreateBookingUseCase,
    CancelBookingUseCase,
    AdminCancelBookingUseCase,
    BookingQueryService,
    BookingMaintenanceService,
    BookingCacheService,
    BookingZoneNotifierService,
    BookingPresenter,
    BookingCodeService,
    BookingWorkflowService,
    BookingScheduler,
    EventOwnershipService,
  ],
  exports: [BookingService],
})
export class BookingModule {}
