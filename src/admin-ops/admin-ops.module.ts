import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import {
  Notification,
  NotificationSchema,
} from "@src/schemas/notification.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { AuditModule } from "@src/audit/audit.module";
import { NotificationModule } from "@src/notification/notification.module";
import { QueueModule } from "@src/queue/queue.module";
import { ReportModule } from "@src/report/report.module";
import { TicketModule } from "@src/ticket/ticket.module";
import { GetAnomaliesUseCase } from "./application/get-anomalies.use-case";
import { GetSystemSummaryUseCase } from "./application/get-system-summary.use-case";
import { RegenerateTicketQrAdminUseCase } from "./application/regenerate-ticket-qr.use-case";
import { ReissueTicketsUseCase } from "./application/reissue-tickets.use-case";
import { ResendConfirmationUseCase } from "./application/resend-confirmation.use-case";
import { AdminOpsRepository } from "./infrastructure/persistence/admin-ops.repository";
import { AdminOpsController } from "./admin-ops.controller";
import { AdminOpsService } from "./admin-ops.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Booking.name, schema: BookingSchema },
      { name: Ticket.name, schema: TicketSchema },
      { name: Notification.name, schema: NotificationSchema },
    ]),
    ReportModule,
    TicketModule,
    NotificationModule,
    QueueModule,
    AuditModule,
  ],
  controllers: [AdminOpsController],
  providers: [
    AdminOpsService,
    AdminOpsRepository,
    GetSystemSummaryUseCase,
    GetAnomaliesUseCase,
    ReissueTicketsUseCase,
    ResendConfirmationUseCase,
    RegenerateTicketQrAdminUseCase,
  ],
  exports: [AdminOpsService],
})
export class AdminOpsModule {}
