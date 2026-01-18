import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { User } from "@src/schemas/user.schema";
@Injectable()
export class UserEventsService {
    constructor(
        private readonly eventEmitter: EventEmitter2,
    ) {}

    emitUserRegistered(user: User): void {
        this.eventEmitter.emit('user.registered', user); // event name, event data
    }
}
