import { Module } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { PaymentController } from './payment.controller';
import { MongooseModule } from '@nestjs/mongoose';
import { Booking, BookingSchema } from '@src/schemas/booking.schema';
import { BookingModule } from '@src/booking/booking.module';
import { Payment, PaymentSchema } from '@src/schemas/payment.schema';
import { Zone, ZoneSchema } from '@src/schemas/zone.schema';
import { TicketModule } from '@src/ticket/ticket.module';
import { MailModule } from '@src/services/mail.module';
@Module({
  imports:[
    MongooseModule.forFeature([
      {name : Payment.name, schema: PaymentSchema},
      { name: Booking.name, schema: BookingSchema },
      { name: Zone.name, schema: ZoneSchema }
    ]),
    BookingModule,
    TicketModule,
    MailModule,
 ],
  controllers: [PaymentController],
  providers: [PaymentService],
})
export class PaymentModule {}
