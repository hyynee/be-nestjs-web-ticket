import { Module, forwardRef } from "@nestjs/common";
import { BookingService } from "./booking.service";
import { BookingController } from "./booking.controller";
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
import { BookingScheduler } from "./booking.scheduler";
import { ZoneModule } from "@src/zone/zone.module";
import { PaymentModule } from "@src/payment/payment.module";
import { UploadModule } from "@src/upload/upload.module";

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
    ]),
    ZoneModule,
    PaymentModule,
    UploadModule,
  ],
  controllers: [BookingController],
  providers: [BookingService, BookingScheduler],
  exports: [BookingService],
})
export class BookingModule {}
