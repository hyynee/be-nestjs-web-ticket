import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import { Types } from "mongoose";
import { NotificationService } from "@src/notification/notification.service";
import { User } from "@src/schemas/user.schema";
import type { BookingConfirmationData } from "@src/types/booking-modules";

@Injectable()
export class UserRegisterListener {
  private readonly logger = new Logger(UserRegisterListener.name);
  constructor(private readonly notificationService: NotificationService) {}

  @OnEvent("user.registered")
  async handleUserRegisteredEvent(payload: User): Promise<void> {
    try {
      const userId = this.resolveUserId(payload);
      await this.notificationService.notifyRegisterSuccess({
        userId,
        email: payload.email,
        fullName: payload.fullName,
      });
    } catch (error) {
      this.logger.error(
        `user.registered notification failed: ${(error as Error)?.message ?? String(error)}`
      );
    }
  }

  @OnEvent("password.reset.requested")
  async handlePasswordResetEvent(payload: {
    email: string;
    resetToken: string;
    fullName: string;
  }): Promise<void> {
    try {
      await this.notificationService.queuePasswordReset(payload);
    } catch (error) {
      this.logger.error(
        `password.reset.requested notification failed: ${(error as Error)?.message ?? String(error)}`
      );
    }
  }
  @OnEvent("email.verification.requested")
  async handleEmailVerificationRequestedEvent(payload: {
    email: string;
    token: string;
    fullName: string;
  }): Promise<void> {
    try {
      await this.notificationService.queueEmailVerification(payload);
    } catch (error) {
      this.logger.error(
        `email.verification.requested notification failed: ${(error as Error)?.message ?? String(error)}`
      );
    }
  }

  @OnEvent("booking.confirmation")
  async handleBookingConfirmationEvent(
    payload: BookingConfirmationData
  ): Promise<void> {
    try {
      await this.notificationService.queueBookingConfirmationEmail(payload);
    } catch (error) {
      this.logger.error(
        `booking.confirmation notification failed: ${(error as Error)?.message ?? String(error)}`
      );
    }
  }

  private resolveUserId(payload: User): string {
    const id = payload._id as Types.ObjectId | string | undefined;
    if (!id) {
      throw new Error("User id is missing from user.registered event");
    }
    return id.toString();
  }
}
