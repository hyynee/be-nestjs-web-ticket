import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Event, EventSchema } from "@src/schemas/event.schema";
import {
  Notification,
  NotificationSchema,
} from "@src/schemas/notification.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { User, UserSchema } from "@src/schemas/user.schema";
import { QueueModule } from "@src/queue/queue.module";
import { RedisModule } from "@src/redis/redis.module";
import { ReportModule } from "@src/report/report.module";
import { MailModule } from "@src/services/mail.module";
import { NotificationEmailService } from "./application/notification-email.service";
import { NotificationEventService } from "./application/notification-event.service";
import { NotificationQueryService } from "./application/notification-query.service";
import { NotificationReadService } from "./application/notification-read.service";
import { NotificationReminderService } from "./application/notification-reminder.service";
import { NotificationWriterService } from "./application/notification-writer.service";
import { NotificationRepository } from "./infrastructure/persistence/notification.repository";
import { NotificationController } from "./notification.controller";
import { NotificationPresenter } from "./notification.presenter";
import { NotificationScheduler } from "./notification.scheduler";
import { NotificationService } from "./notification.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
      { name: User.name, schema: UserSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Event.name, schema: EventSchema },
      { name: Ticket.name, schema: TicketSchema },
    ]),
    QueueModule,
    RedisModule,
    ReportModule,
    MailModule,
  ],
  controllers: [NotificationController],
  providers: [
    NotificationService,
    NotificationRepository,
    NotificationQueryService,
    NotificationReadService,
    NotificationWriterService,
    NotificationEmailService,
    NotificationEventService,
    NotificationReminderService,
    NotificationPresenter,
    NotificationScheduler,
  ],
  exports: [NotificationService],
})
export class NotificationModule {}
