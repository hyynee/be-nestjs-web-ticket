import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { ExportModule } from "@src/export/export.module";
import { InvoiceModule } from "@src/invoice/invoice.module";
import { User, UserSchema } from "@src/schemas/user.schema";
import { MailModule } from "@src/services/mail.module";
import { TicketModule } from "@src/ticket/ticket.module";
import { QueueModule } from "./queue.module";
import { QueueProcessor } from "./queue.processor";

@Module({
  imports: [
    QueueModule,
    MailModule,
    ExportModule,
    TicketModule,
    InvoiceModule,
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
  ],
  providers: [QueueProcessor],
})
export class QueueWorkerModule {}
