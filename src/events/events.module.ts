import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";
import { UserEventsService } from "./user-event.services";
import { UserRegisterListener } from "./listeners/user-register.listener";
import { NotificationModule } from "@src/notification/notification.module";

@Module({
  imports: [
    EventEmitterModule.forRoot({
      global: true,
      wildcard: false,
      maxListeners: 20,
      verboseMemoryLeak: true,
    }),
    NotificationModule,
  ],
  providers: [UserEventsService, UserRegisterListener],
  exports: [UserEventsService],
})
export class EventsModule {}
