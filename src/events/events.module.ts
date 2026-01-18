import { Module } from "@nestjs/common";
import { EventEmitter2, EventEmitterModule } from "@nestjs/event-emitter";
import { UserEventsService } from "./user-event.services";
import { UserRegisterListener } from "./listeners/user-register.listener";
import { MailModule } from "@src/services/mail.module";

@Module({
    imports: [
        EventEmitterModule.forRoot({
            global: true,
            wildcard: false,
            maxListeners:20,
            verboseMemoryLeak: true,
        }),
        MailModule
    ],
    providers: [
        UserEventsService, UserRegisterListener
    ],
    exports: [UserEventsService],
}) 
export class EventsModule {}