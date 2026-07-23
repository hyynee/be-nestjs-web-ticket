import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { EventModule } from "@src/event/event.module";
import { ExportModule } from "@src/export/export.module";
import { InvoiceModule } from "@src/invoice/invoice.module";
import { NotificationModule } from "@src/notification/notification.module";
import { User, UserSchema } from "@src/schemas/user.schema";
import { MailModule } from "@src/services/mail.module";
import { TicketModule } from "@src/ticket/ticket.module";
import { QueueModule } from "./queue.module";
import { QueueProcessor } from "./queue.processor";
import { EventCancellationQueueProcessor } from "./event-cancellation-queue.processor";

@Module({
  imports: [
    QueueModule,
    MailModule,
    ExportModule,
    TicketModule,
    InvoiceModule,
    NotificationModule,
    EventModule,
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [QueueProcessor, EventCancellationQueueProcessor],
})
export class QueueWorkerModule {}
