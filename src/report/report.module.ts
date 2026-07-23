import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import {
  PaymentWebhookEvent,
  PaymentWebhookEventSchema,
} from "@src/schemas/payment-webhook-event.schema";
import {
  RefundRequest,
  RefundRequestSchema,
} from "@src/schemas/refund-request.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { CheckInReportQueryService } from "./application/checkin-report-query.service";
import { OrganizerReportQueryService } from "./application/organizer-report-query.service";
import { PaymentReconciliationQueryService } from "./application/payment-reconciliation-query.service";
import { RefundReportQueryService } from "./application/refund-report-query.service";
import { SalesReportQueryService } from "./application/sales-report-query.service";
import { ReportScopePolicy } from "./domain/policies/report-scope.policy";
import { ReportCacheService } from "./infrastructure/cache/report-cache.service";
import { ReportRepository } from "./infrastructure/persistence/report.repository";
import { ReportController } from "./report.controller";
import { ReportService } from "./report.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: Ticket.name, schema: TicketSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: RefundRequest.name, schema: RefundRequestSchema },
      { name: PaymentWebhookEvent.name, schema: PaymentWebhookEventSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [ReportController],
  providers: [
    ReportService,
    ReportRepository,
    ReportScopePolicy,
    ReportCacheService,
    EventOwnershipService,
    SalesReportQueryService,
    CheckInReportQueryService,
    RefundReportQueryService,
    PaymentReconciliationQueryService,
    OrganizerReportQueryService,
  ],
  exports: [ReportService, ReportCacheService, ReportRepository],
})
export class ReportModule {}
