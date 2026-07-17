import { Module } from "@nestjs/common";
import { StatisticalService } from "./statistical.service";
import { StatisticalController } from "./statistical.controller";
import { StatisticalScheduler } from "./statistical.scheduler";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { MongooseModule } from "@nestjs/mongoose";
import { EventSchema, Event } from "@src/schemas/event.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { StatisticalCacheService } from "./infrastructure/cache/statistical-cache.service";
import { StatisticalRepository } from "./infrastructure/persistence/statistical.repository";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Ticket.name, schema: TicketSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [StatisticalController],
  providers: [
    StatisticalService,
    StatisticalScheduler,
    StatisticalRepository,
    StatisticalCacheService,
    EventOwnershipService,
  ],
})
export class StatisticalModule {}
