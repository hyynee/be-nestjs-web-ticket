import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { NotificationEmailService } from "./application/notification-email.service";
import { NotificationEventService } from "./application/notification-event.service";
import { NotificationQueryService } from "./application/notification-query.service";
import { NotificationReadService } from "./application/notification-read.service";
import { NotificationReminderService } from "./application/notification-reminder.service";
import { QueryNotificationDto } from "./dto/query-notification.dto";
import type {
  NotificationDetail,
  NotificationEmailPayload,
  NotificationEmailTemplate,
  NotificationListResult,
  NotificationReadAllResult,
  NotificationReadResult,
  NotificationRetryResult,
  NotificationUnreadCountResult,
  SendBookingExpiryReminderJobPayload,
  SendEventReminderJobPayload,
} from "./types/notification.types";
import type { EmailNotificationInput } from "./application/notification-email.service";
import type { NotificationCreateInput } from "./application/notification-writer.service";

type InAppNotificationInput = Omit<
  NotificationCreateInput,
  "channel" | "status"
>;

@Injectable()
export class NotificationService {
  constructor(
    private readonly queries: NotificationQueryService,
    private readonly reads: NotificationReadService,
    private readonly emails: NotificationEmailService,
    private readonly events: NotificationEventService,
    private readonly reminders: NotificationReminderService
  ) {}

  listForUser(
    userId: string,
    query: QueryNotificationDto
  ): Promise<NotificationListResult> {
    return this.queries.listForUser(userId, query);
  }

  unreadCount(userId: string): Promise<NotificationUnreadCountResult> {
    return this.queries.unreadCount(userId);
  }

  markAsRead(userId: string, id: string): Promise<NotificationReadResult> {
    return this.reads.markAsRead(userId, id);
  }

  markAllAsRead(userId: string): Promise<NotificationReadAllResult> {
    return this.reads.markAllAsRead(userId);
  }

  listForAdmin(query: QueryNotificationDto): Promise<NotificationListResult> {
    return this.queries.listForAdmin(query);
  }

  getForAdmin(id: string): Promise<NotificationDetail> {
    return this.queries.getForAdmin(id);
  }

  retryEmail(id: string): Promise<NotificationRetryResult> {
    return this.emails.retryEmail(id);
  }

  createInAppNotification(
    input: InAppNotificationInput
  ): Promise<NotificationDetail> {
    return this.events.createInAppNotification(input);
  }

  queueEmailNotification(
    input: EmailNotificationInput
  ): Promise<NotificationDetail> {
    return this.events.queueEmailNotification(input);
  }

  createInAppSafely(input: InAppNotificationInput): Promise<void> {
    return this.events.createInAppSafely(input);
  }

  queueEmailSafely(input: EmailNotificationInput): Promise<void> {
    return this.events.queueEmailSafely(input);
  }

  notifyRegisterSuccess(payload: {
    userId: string | Types.ObjectId;
    email: string;
    fullName: string;
  }): Promise<void> {
    return this.events.notifyRegisterSuccess(payload);
  }

  queueEmailVerification(payload: {
    email: string;
    token: string;
    fullName: string;
  }): Promise<void> {
    return this.events.queueEmailVerification(payload);
  }

  queuePasswordReset(payload: {
    email: string;
    resetToken: string;
    fullName: string;
  }): Promise<void> {
    return this.events.queuePasswordReset(payload);
  }

  queueBookingConfirmationEmail(
    payload: import("@src/types/booking-modules").BookingConfirmationData,
    userId?: string | Types.ObjectId
  ): Promise<void> {
    return this.events.queueBookingConfirmationEmail(payload, userId);
  }

  resendBookingConfirmationEmail(
    payload: import("@src/types/booking-modules").BookingConfirmationData,
    userId?: string | Types.ObjectId
  ): Promise<void> {
    return this.events.resendBookingConfirmationEmail(payload, userId);
  }

  notifyBookingCreated(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId?: string;
    eventTitle?: string;
    expiresAt?: Date;
  }): Promise<void> {
    return this.events.notifyBookingCreated(payload);
  }

  notifyBookingCancelled(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId?: string;
    reason?: string;
  }): Promise<void> {
    return this.events.notifyBookingCancelled(payload);
  }

  notifyPaymentSucceeded(payload: {
    userId: string | Types.ObjectId;
    bookingId?: string;
    bookingCode: string;
    eventId?: string;
    provider: string;
  }): Promise<void> {
    return this.events.notifyPaymentSucceeded(payload);
  }

  notifyTicketsIssued(payload: {
    userId: string | Types.ObjectId;
    bookingId?: string;
    bookingCode: string;
    eventId?: string;
  }): Promise<void> {
    return this.events.notifyTicketsIssued(payload);
  }

  notifyRefundRequested(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId: string;
    refundRequestId: string;
    amount: number;
  }): Promise<void> {
    return this.events.notifyRefundRequested(payload);
  }

  notifyRefundReviewed(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId: string;
    refundRequestId: string;
    approved: boolean;
    amount: number;
  }): Promise<void> {
    return this.events.notifyRefundReviewed(payload);
  }

  notifyRefundFailed(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId: string;
    refundRequestId: string;
    amount: number;
    reason?: string;
  }): Promise<void> {
    return this.events.notifyRefundFailed(payload);
  }

  deliverQueuedEmail(
    notificationId: string,
    template: NotificationEmailTemplate,
    payload: NotificationEmailPayload
  ): Promise<void> {
    return this.emails.deliverQueuedEmail(notificationId, template, payload);
  }

  processBookingExpiryReminderJob(
    payload: SendBookingExpiryReminderJobPayload
  ): Promise<void> {
    return this.reminders.processBookingExpiryReminderJob(payload);
  }

  processEventReminderJob(payload: SendEventReminderJobPayload): Promise<void> {
    return this.reminders.processEventReminderJob(payload);
  }
}
