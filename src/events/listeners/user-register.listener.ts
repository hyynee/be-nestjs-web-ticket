import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { User } from "@src/schemas/user.schema";
import { MailService } from "@src/services/mail.service";
import type { BookingConfirmationData } from "@src/types/booking-modules";

@Injectable()
export class UserRegisterListener {
  private readonly logger = new Logger(UserRegisterListener.name);
  constructor(private readonly mail: MailService) {}

  @OnEvent("user.registered")
  async handleUserRegisteredEvent(payload: User) {
    try {
      const { email, fullName } = payload;
      await this.mail.sendRegisterEmail(email, fullName);
    } catch (error) {
      this.logger.error("Send mail failed", error);
    }
  }

  @OnEvent("password.reset.requested")
  async handlePasswordResetEvent(payload: {
    email: string;
    resetToken: string;
    fullName: string;
  }) {
    try {
      await this.mail.sendPasswordResetEmail(
        payload.email,
        payload.resetToken,
        payload.fullName
      );
    } catch (error) {
      this.logger.error("Send password reset email failed", error);
    }
  }
  @OnEvent("booking.confirmation")
  async handleBookingConfirmationEvent(payload: BookingConfirmationData) {
    try {
      await this.mail.sendBookingConfirmation(payload);
    } catch (error) {
      this.logger.error("Send booking confirmation email failed", error);
    }
  }
}
