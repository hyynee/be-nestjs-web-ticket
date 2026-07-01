import { Module } from "@nestjs/common";
import { PaymentService } from "./payment.service";
import { PaymentController } from "./payment.controller";
import { PaymentScheduler } from "./payment.scheduler";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { TicketModule } from "@src/ticket/ticket.module";
import { MailModule } from "@src/services/mail.module";
import { ZoneModule } from "@src/zone/zone.module";
import { EventsModule } from "@src/events/events.module";
import { QueueModule } from "@src/queue/queue.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Ticket.name, schema: TicketSchema },
    ]),
    TicketModule,
    MailModule,
    ZoneModule,
    EventsModule,
    QueueModule,
  ],
  controllers: [PaymentController],
  providers: [PaymentService, PaymentScheduler],
  exports: [PaymentService],
})
export class PaymentModule {}
