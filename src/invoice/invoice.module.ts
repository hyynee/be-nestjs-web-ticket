import { forwardRef, Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { MailModule } from "@src/services/mail.module";
import { QueueModule } from "@src/queue/queue.module";
import { InvoiceController } from "./invoice.controller";
import { InvoiceService } from "./invoice.service";
import { InvoicePdfService } from "./infrastructure/pdf/invoice-pdf.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Event.name, schema: EventSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Area.name, schema: AreaSchema },
    ]),
    MailModule,
    forwardRef(() => QueueModule),
  ],
  controllers: [InvoiceController],
  providers: [InvoiceService, InvoicePdfService],
  exports: [InvoiceService],
})
export class InvoiceModule {}
