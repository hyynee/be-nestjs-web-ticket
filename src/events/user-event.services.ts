import { Injectable } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { User } from "@src/schemas/user.schema";
import { BookingConfirmationData } from "@src/types/booking-modules";
@Injectable()
export class UserEventsService {
  constructor(private readonly eventEmitter: EventEmitter2) {}

  emitUserRegistered(user: User): void {
    this.eventEmitter.emit("user.registered", user); // event name, event data
  }
  emitPasswordResetRequested(email: string, resetToken: string, fullName: string): void {
    this.eventEmitter.emit("password.reset.requested", {
      email,
      resetToken,
      fullName
    });
  }

  emitPasswordResetSuccess(email: string, fullName: string): void {
    this.eventEmitter.emit("password.reset.success", { email, fullName });
  }

  emitSendBookingConfirmation(data: BookingConfirmationData): void {
    this.eventEmitter.emit("booking.confirmation", data);
  }

}
