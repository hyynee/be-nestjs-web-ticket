import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AiccController } from "./aicc.controller";
import { AiccService } from "./aicc.service";
import { AiccMessage, AiccMessageSchema } from "./schemas/aicc-message.schema";
import { AiccSession, AiccSessionSchema } from "./schemas/aicc-session.schema";
import {
  AiccToolCall,
  AiccToolCallSchema,
} from "./schemas/aicc-tool-call.schema";
import { AiccHandoff, AiccHandoffSchema } from "./schemas/aicc-handoff.schema";
import {
  AiccKnowledge,
  AiccKnowledgeSchema,
} from "./schemas/aicc-knowledge.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { AiccOrchestratorService } from "./orchestrator/aicc-orchestrator.service";
import { AiccEventTool } from "./tools/event.tool";
import { AiccBookingTool } from "./tools/booking.tool";
import { AiccPaymentTool } from "./tools/payment.tool";
import { AiccTicketTool } from "./tools/ticket.tool";
import { AiccKnowledgeTool } from "./tools/knowledge.tool";
import { AiccGateway } from "./aicc.gateway";
import { AiccPresenter } from "./presenters/aicc.presenter";
import { AiccKnowledgeService } from "./application/aicc-knowledge.service";
import { AiccHandoffService } from "./application/aicc-handoff.service";
import { AiccEntityInterpreterService } from "./orchestrator/aicc-entity-interpreter.service";
import { AiccResponseComposerService } from "./orchestrator/aicc-response-composer.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AiccSession.name, schema: AiccSessionSchema },
      { name: AiccMessage.name, schema: AiccMessageSchema },
      { name: AiccToolCall.name, schema: AiccToolCallSchema },
      { name: AiccHandoff.name, schema: AiccHandoffSchema },
      { name: AiccKnowledge.name, schema: AiccKnowledgeSchema },
      { name: Event.name, schema: EventSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Area.name, schema: AreaSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Ticket.name, schema: TicketSchema },
    ]),
  ],
  controllers: [AiccController],
  providers: [
    AiccService,
    AiccKnowledgeService,
    AiccHandoffService,
    AiccOrchestratorService,
    AiccEntityInterpreterService,
    AiccResponseComposerService,
    AiccEventTool,
    AiccBookingTool,
    AiccPaymentTool,
    AiccTicketTool,
    AiccKnowledgeTool,
    AiccPresenter,
    AiccGateway,
  ],
  exports: [AiccService],
})
export class AiccModule {}
