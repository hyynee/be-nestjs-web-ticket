import { Module } from '@nestjs/common';
import { StatisticalService } from './statistical.service';
import { StatisticalController } from './statistical.controller';
import { Booking, BookingSchema } from '@src/schemas/booking.schema';
import { Payment, PaymentSchema } from '@src/schemas/payment.schema';
import { Ticket, TicketSchema } from '@src/schemas/ticket.schema';
import { MongooseModule } from '@nestjs/mongoose';
import { EventSchema ,Event} from '@src/schemas/event.schema';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Booking.name, schema: BookingSchema },{ name: Payment.name, schema: PaymentSchema }, { name: Ticket.name, schema: TicketSchema },{ name: Event.name, schema: EventSchema }]),
  ],
  controllers: [StatisticalController],
  providers: [StatisticalService],
})
export class StatisticalModule {}
