import type { BookingConfirmationData } from "@src/types/booking-modules";
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from "@src/schemas/notification.schema";

export type NotificationEmailTemplate =
  | "register"
  | "email-verification"
  | "password-reset"
  | "booking-confirmation"
  | "booking-cancellation"
  | "event-reminder"
  | "generic";

export interface RegisterNotificationEmailPayload {
  to: string;
  fullName: string;
}

export interface VerificationNotificationEmailPayload {
  to: string;
  token: string;
  fullName: string;
}

export interface PasswordResetNotificationEmailPayload {
  email: string;
  resetToken: string;
  fullName: string;
}

export interface BookingCancellationNotificationEmailPayload {
  email: string;
  customerName: string;
  bookingCode: string;
  eventTitle: string;
  refundAmount?: number;
}

export interface EventReminderNotificationEmailPayload {
  email: string;
  customerName: string;
  eventTitle: string;
  eventDate: Date | string;
  eventLocation: string;
  bookingCode: string;
}

export interface GenericNotificationEmailPayload {
  to: string;
  title: string;
  body: string;
}

export type NotificationEmailPayload =
  | RegisterNotificationEmailPayload
  | VerificationNotificationEmailPayload
  | PasswordResetNotificationEmailPayload
  | BookingConfirmationData
  | BookingCancellationNotificationEmailPayload
  | EventReminderNotificationEmailPayload
  | GenericNotificationEmailPayload;

export interface SendNotificationEmailJobPayload {
  notificationId: string;
  template: NotificationEmailTemplate;
  payload: NotificationEmailPayload;
}

export interface SendBookingExpiryReminderJobPayload {
  bookingId: string;
}

export type EventReminderWindow = "24h" | "2h";

export interface SendEventReminderJobPayload {
  ticketId: string;
  reminderWindow: EventReminderWindow;
}

export interface NotificationMetadata {
  idempotencyKey?: string;
  bookingId?: string;
  bookingCode?: string;
  eventId?: string;
  ticketId?: string;
  refundRequestId?: string;
  paymentId?: string;
  provider?: string;
  template?: NotificationEmailTemplate;
  reminderWindow?: EventReminderWindow;
}

export interface NotificationDetail {
  id: string;
  userId: string;
  type: NotificationType;
  channel: NotificationChannel;
  title: string;
  body: string;
  status: NotificationStatus;
  recipientEmail?: string;
  metadata?: NotificationMetadata;
  sentAt?: string;
  readAt?: string;
  errorMessage?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NotificationListResult {
  items: NotificationDetail[];
  total: number;
  page: number;
  limit: number;
}

export interface NotificationUnreadCountResult {
  unreadCount: number;
}

export interface NotificationReadResult {
  id: string;
  read: boolean;
}

export interface NotificationReadAllResult {
  modifiedCount: number;
}

export interface NotificationRetryResult {
  id: string;
  status: NotificationStatus.QUEUED;
}
