import { Module } from "@nestjs/common";
import { ExportController } from "./export.controller";
import { ExportService } from "./export.service";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { MongooseModule } from "@nestjs/mongoose";
import { forwardRef } from "@nestjs/common";
import { QueueModule } from "@src/queue/queue.module";
import { EventOwnershipService } from "@src/event/event-ownership.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Ticket.name, schema: TicketSchema }]),
    MongooseModule.forFeature([{ name: Zone.name, schema: ZoneSchema }]),
    MongooseModule.forFeature([{ name: Event.name, schema: EventSchema }]),
    forwardRef(() => QueueModule),
  ],
  controllers: [ExportController],
  providers: [ExportService, EventOwnershipService],
  exports: [ExportService],
})
export class ExportModule {}
