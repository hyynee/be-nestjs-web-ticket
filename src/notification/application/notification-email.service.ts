import {
  BadRequestException,
  ConflictException,
  Injectable,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { QueueService } from "@src/queue/queue.service";
import {
  NotificationChannel,
  NotificationStatus,
} from "@src/schemas/notification.schema";
import { User } from "@src/schemas/user.schema";
import { MailService } from "@src/services/mail.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { Model } from "mongoose";
import { NotificationRepository } from "../infrastructure/persistence/notification.repository";
import type { NotificationDocument } from "../domain/types/notification-domain.types";
import {
  BookingCancellationNotificationEmailPayload,
  EventReminderNotificationEmailPayload,
  GenericNotificationEmailPayload,
  NotificationDetail,
  NotificationEmailPayload,
  NotificationEmailTemplate,
  NotificationRetryResult,
  PasswordResetNotificationEmailPayload,
  RegisterNotificationEmailPayload,
  SendNotificationEmailJobPayload,
  VerificationNotificationEmailPayload,
} from "../types/notification.types";
import {
  NotificationCreateInput,
  NotificationWriterService,
} from "./notification-writer.service";

export type EmailNotificationInput = Omit<
  NotificationCreateInput,
  "channel" | "status"
> & {
  template: NotificationEmailTemplate;
  payload: NotificationEmailPayload;
};

const NOTIFICATION_EMAIL_JOB = "send-notification-email";

const buildNotificationEmailJobId = (notificationId: string): string =>
  `${NOTIFICATION_EMAIL_JOB}-${notificationId}`;

@Injectable()
export class NotificationEmailService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly writer: NotificationWriterService,
    private readonly queueService: QueueService,
    private readonly mailService: MailService,
    @InjectModel(User.name) private readonly userModel: Model<User>
  ) {}

  async queueEmailNotification(
    input: EmailNotificationInput
  ): Promise<NotificationDetail> {
    const detail = await this.writer.createNotification({
      ...input,
      channel: NotificationChannel.EMAIL,
      status: NotificationStatus.QUEUED,
      metadata: {
        ...(input.metadata ?? {}),
        template: input.template,
      },
    });

    if (detail.status !== NotificationStatus.QUEUED) {
      return detail;
    }

    try {
      await this.enqueueEmailJob({
        notificationId: detail.id,
        template: input.template,
        payload: input.payload,
      });
    } catch (error) {
      await this.markFailed(detail.id, getErrorMessage(error));
      throw error;
    }

    return detail;
  }

  async retryEmail(id: string): Promise<NotificationRetryResult> {
    const notification = await this.repository.loadById(id);
    if (notification.channel !== NotificationChannel.EMAIL) {
      throw new BadRequestException("Only email notifications can be retried");
    }
    if (notification.status !== NotificationStatus.FAILED) {
      throw new ConflictException("Only failed notifications can be retried");
    }

    const template = notification.metadata?.template;
    if (!this.isNotificationEmailTemplate(template)) {
      throw new BadRequestException("Notification is missing email template");
    }

    const updated = await this.repository.findOneAndUpdate(
      { _id: notification._id, status: NotificationStatus.FAILED },
      {
        $set: { status: NotificationStatus.QUEUED },
        $unset: { errorMessage: "" },
      }
    );

    if (!updated) {
      throw new ConflictException("Notification status changed");
    }

    const notificationId = updated._id.toString();
    const jobId = buildNotificationEmailJobId(notificationId);
    try {
      await this.queueService.retryJob(jobId);
    } catch (error) {
      const rebuiltPayload = await this.rebuildRetryPayloadForMissingJob(
        updated,
        template
      );
      if (!rebuiltPayload) {
        await this.markFailed(updated._id.toString(), getErrorMessage(error));
        throw new BadRequestException(
          "Original email job is no longer available; retry it from queue/dead-letter history"
        );
      }
      await this.enqueueEmailJob({
        notificationId,
        template,
        payload: rebuiltPayload,
      });
    }

    return { id: updated._id.toString(), status: NotificationStatus.QUEUED };
  }

  async deliverQueuedEmail(
    notificationId: string,
    template: NotificationEmailTemplate,
    payload: NotificationEmailPayload
  ): Promise<void> {
    const notification = await this.repository.loadById(notificationId);
    if (notification.channel !== NotificationChannel.EMAIL) {
      throw new BadRequestException("Notification is not an email");
    }
    if (notification.status === NotificationStatus.SENT) {
      return;
    }

    try {
      await this.deliverByTemplate(template, payload);
      await this.repository.updateOne(
        { _id: notification._id },
        {
          $set: { status: NotificationStatus.SENT, sentAt: new Date() },
          $unset: { errorMessage: "" },
        }
      );
    } catch (error) {
      const message = getErrorMessage(error);
      await this.markFailed(notification._id.toString(), message);
      throw error;
    }
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.repository.updateOne(
      { _id: this.repository.toObjectId(id, "Invalid notification ID") },
      {
        $set: {
          status: NotificationStatus.FAILED,
          errorMessage: errorMessage.slice(0, 1000),
        },
      }
    );
  }

  private async enqueueEmailJob(
    payload: SendNotificationEmailJobPayload
  ): Promise<void> {
    await this.queueService.addJob(
      {
        type: NOTIFICATION_EMAIL_JOB,
        payload,
        requestedAt: new Date().toISOString(),
      },
      { jobId: buildNotificationEmailJobId(payload.notificationId) }
    );
  }

  private async deliverByTemplate(
    template: NotificationEmailTemplate,
    payload: NotificationEmailPayload
  ): Promise<void> {
    switch (template) {
      case "register": {
        const data = payload as RegisterNotificationEmailPayload;
        await this.mailService.deliverRegisterEmail(data.to, data.fullName);
        return;
      }
      case "email-verification": {
        const data = payload as VerificationNotificationEmailPayload;
        await this.mailService.deliverVerificationEmail(
          data.to,
          data.token,
          data.fullName
        );
        return;
      }
      case "password-reset": {
        const data = payload as PasswordResetNotificationEmailPayload;
        await this.mailService.deliverPasswordResetEmail(
          data.email,
          data.resetToken,
          data.fullName
        );
        return;
      }
      case "booking-confirmation":
        await this.mailService.deliverBookingConfirmation(
          payload as import("@src/types/booking-modules").BookingConfirmationData
        );
        return;
      case "booking-cancellation":
        await this.mailService.sendBookingCancellation(
          payload as BookingCancellationNotificationEmailPayload
        );
        return;
      case "event-reminder": {
        const data = payload as EventReminderNotificationEmailPayload;
        await this.mailService.sendEventReminder({
          ...data,
          eventDate: new Date(data.eventDate),
        });
        return;
      }
      case "generic": {
        const data = payload as GenericNotificationEmailPayload;
        await this.mailService.deliverNotificationEmail(data);
        return;
      }
    }
  }

  private async rebuildRetryPayloadForMissingJob(
    notification: NotificationDocument,
    template: NotificationEmailTemplate
  ): Promise<NotificationEmailPayload | undefined> {
    if (template === "generic") {
      return this.rebuildGenericRetryPayload(notification);
    }
    if (template === "register") {
      return this.rebuildRegisterRetryPayload(notification);
    }
    return undefined;
  }

  private rebuildGenericRetryPayload(
    notification: NotificationDocument
  ): GenericNotificationEmailPayload {
    if (!notification.recipientEmail) {
      throw new BadRequestException("Notification recipient email is missing");
    }
    return {
      to: notification.recipientEmail,
      title: notification.title,
      body: notification.body,
    };
  }

  private async rebuildRegisterRetryPayload(
    notification: NotificationDocument
  ): Promise<RegisterNotificationEmailPayload> {
    if (!notification.recipientEmail) {
      throw new BadRequestException("Notification recipient email is missing");
    }
    const user = await this.userModel
      .findById(notification.userId)
      .select("fullName")
      .lean<{ fullName?: string }>();
    return {
      to: notification.recipientEmail,
      fullName: user?.fullName ?? notification.recipientEmail,
    };
  }

  private isNotificationEmailTemplate(
    value: unknown
  ): value is NotificationEmailTemplate {
    return (
      value === "register" ||
      value === "email-verification" ||
      value === "password-reset" ||
      value === "booking-confirmation" ||
      value === "booking-cancellation" ||
      value === "event-reminder" ||
      value === "generic"
    );
  }
}
