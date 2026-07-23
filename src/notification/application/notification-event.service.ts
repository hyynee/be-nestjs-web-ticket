import { Injectable, Logger } from "@nestjs/common";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { MetricsService } from "@src/metrics/metrics.service";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from "@src/schemas/notification.schema";
import * as crypto from "crypto";
import { Types } from "mongoose";
import {
  EmailNotificationInput,
  NotificationEmailService,
} from "./notification-email.service";
import {
  NotificationCreateInput,
  NotificationWriterService,
} from "./notification-writer.service";

type InAppNotificationInput = Omit<
  NotificationCreateInput,
  "channel" | "status"
>;

@Injectable()
export class NotificationEventService {
  private readonly logger = new Logger(NotificationEventService.name);

  constructor(
    private readonly writer: NotificationWriterService,
    private readonly emails: NotificationEmailService,
    private readonly reportCache: ReportCacheService,
    private readonly metricsService: MetricsService
  ) {}

  /**
   * Mongo's duplicate-key error (E11000) here means NotificationWriterService
   * already tried and failed to resolve it to the existing idempotent record
   * (see its own isDuplicateKeyError check) — a benign, expected outcome of
   * concurrent/retried delivery. Anything else is a genuine failure (DB
   * down, network partition, validation bug) and MUST NOT be swallowed the
   * same way rule.md 4.1 forbids `catch {}`: it needs a metric so a real
   * failure is discoverable, not just a warn line buried in stdout.
   */
  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }

  private recordDeliveryFailure(
    channel: "in_app" | "email",
    operation: string,
    input: { type: string; userId?: string | Types.ObjectId },
    error: unknown
  ): void {
    const context = `${operation} failed type=${input.type} userId=${input.userId?.toString() ?? "unknown"}`;
    if (this.isDuplicateKeyError(error)) {
      this.logger.warn(`${context} (duplicate key, expected on retry)`);
      return;
    }
    this.metricsService.notificationFailuresTotal.inc({ channel });
    this.logger.error(
      `${context}: ${getErrorMessage(error)} — notification lost, no retryable record`
    );
  }

  /**
   * Best-effort report-cache invalidation piggybacked on the notification
   * hub methods below, since those already sit at every business event
   * that changes reportable numbers (revenue, ticket counts, refund
   * status). Never allowed to affect notification delivery — failures are
   * logged and swallowed (rule.md 3.5: cache invalidation must not turn a
   * successful state change into a false API failure).
   */
  private invalidateReportCacheSafely(context: string): void {
    this.reportCache.invalidateAll().catch((error: unknown) => {
      this.logger.warn(
        `invalidateReportCacheSafely failed (${context}): ${getErrorMessage(error)}`
      );
    });
  }

  async createInAppNotification(
    input: InAppNotificationInput
  ): ReturnType<NotificationWriterService["createNotification"]> {
    return this.writer.createNotification({
      ...input,
      channel: NotificationChannel.IN_APP,
      status: NotificationStatus.SENT,
    });
  }

  async queueEmailNotification(
    input: EmailNotificationInput
  ): ReturnType<NotificationEmailService["queueEmailNotification"]> {
    return this.emails.queueEmailNotification(input);
  }

  async createInAppSafely(input: InAppNotificationInput): Promise<void> {
    try {
      await this.createInAppNotification(input);
    } catch (error) {
      this.recordDeliveryFailure("in_app", "createInAppSafely", input, error);
    }
  }

  async queueEmailSafely(input: EmailNotificationInput): Promise<void> {
    try {
      await this.queueEmailNotification(input);
    } catch (error) {
      this.recordDeliveryFailure("email", "queueEmailSafely", input, error);
    }
  }

  async notifyRegisterSuccess(payload: {
    userId: string | Types.ObjectId;
    email: string;
    fullName: string;
  }): Promise<void> {
    const userId = payload.userId.toString();
    await Promise.all([
      this.createInAppSafely({
        userId,
        type: NotificationType.REGISTER_SUCCESS,
        title: "Tài khoản đã được tạo",
        body: "Chào mừng bạn đến với Ticket System.",
        metadata: { idempotencyKey: `register-success:${userId}` },
      }),
      this.queueEmailSafely({
        userId,
        recipientEmail: payload.email,
        type: NotificationType.REGISTER_SUCCESS,
        title: "Chào mừng bạn đến với Ticket System",
        body: "Tài khoản của bạn đã được tạo thành công.",
        template: "register",
        payload: { to: payload.email, fullName: payload.fullName },
        metadata: { idempotencyKey: `register-email:${userId}` },
      }),
    ]);
  }

  async queueEmailVerification(payload: {
    email: string;
    token: string;
    fullName: string;
  }): Promise<void> {
    const userId = await this.writer.resolveUserIdByEmail(payload.email);
    await this.queueEmailSafely({
      userId,
      recipientEmail: payload.email,
      type: NotificationType.EMAIL_VERIFICATION,
      title: "Xác thực địa chỉ email",
      body: "Liên kết xác thực email đã được gửi cho bạn.",
      template: "email-verification",
      payload: {
        to: payload.email,
        token: payload.token,
        fullName: payload.fullName,
      },
      metadata: {
        idempotencyKey: `email-verification:${userId}:${Date.now()}`,
      },
    });
  }

  async queuePasswordReset(payload: {
    email: string;
    resetToken: string;
    fullName: string;
  }): Promise<void> {
    const userId = await this.writer.resolveUserIdByEmail(payload.email);
    await this.queueEmailSafely({
      userId,
      recipientEmail: payload.email,
      type: NotificationType.PASSWORD_RESET_REQUESTED,
      title: "Đặt lại mật khẩu",
      body: "Liên kết đặt lại mật khẩu đã được gửi cho bạn.",
      template: "password-reset",
      payload: {
        email: payload.email,
        resetToken: payload.resetToken,
        fullName: payload.fullName,
      },
      metadata: {
        idempotencyKey: `password-reset:${userId}:${Date.now()}`,
      },
    });
  }

  async queueBookingConfirmationEmail(
    payload: import("@src/types/booking-modules").BookingConfirmationData,
    userId?: string | Types.ObjectId
  ): Promise<void> {
    const resolvedUserId =
      userId?.toString() ??
      (await this.writer.resolveUserIdByEmail(payload.email));
    await this.queueEmailSafely({
      userId: resolvedUserId,
      recipientEmail: payload.email,
      type: NotificationType.PAYMENT_SUCCEEDED,
      title: `Thanh toán thành công - ${payload.bookingCode}`,
      body: `Đơn đặt vé ${payload.bookingCode} đã được thanh toán thành công.`,
      template: "booking-confirmation",
      payload,
      metadata: {
        idempotencyKey: `booking-confirmation-email:${payload.bookingCode}`,
        bookingCode: payload.bookingCode,
      },
    });
  }

  /**
   * Admin-triggered "resend confirmation" — deliberately a SEPARATE method
   * from `queueBookingConfirmationEmail`, not a caller of it. That method's
   * idempotencyKey is fixed per bookingCode so a duplicate webhook delivery
   * can't double-send the automatic confirmation; but that means calling it
   * again for a booking that was already confirmed (the normal case for an
   * admin resend — the whole point is the customer already missed the first
   * one) would collide with the original record and — because
   * NotificationWriterService returns the *existing* record on that
   * collision, and queueEmailNotification only enqueues a job when the
   * returned record's status is freshly `queued` — silently return without
   * ever enqueueing a new email. Each admin resend gets its own
   * idempotencyKey (bookingCode + timestamp) so it always creates a new
   * notification record and actually re-sends.
   */
  async resendBookingConfirmationEmail(
    payload: import("@src/types/booking-modules").BookingConfirmationData,
    userId?: string | Types.ObjectId
  ): Promise<void> {
    const resolvedUserId =
      userId?.toString() ??
      (await this.writer.resolveUserIdByEmail(payload.email));
    await this.queueEmailSafely({
      userId: resolvedUserId,
      recipientEmail: payload.email,
      type: NotificationType.PAYMENT_SUCCEEDED,
      title: `Thanh toán thành công - ${payload.bookingCode}`,
      body: `Đơn đặt vé ${payload.bookingCode} đã được thanh toán thành công.`,
      template: "booking-confirmation",
      payload,
      metadata: {
        idempotencyKey: `booking-confirmation-email:resend:${payload.bookingCode}:${Date.now()}:${crypto.randomBytes(4).toString("hex")}`,
        bookingCode: payload.bookingCode,
      },
    });
  }

  async notifyBookingCreated(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId?: string;
    eventTitle?: string;
    expiresAt?: Date;
  }): Promise<void> {
    const body = payload.expiresAt
      ? `Booking ${payload.bookingCode} đã được tạo. Vui lòng thanh toán trước ${payload.expiresAt.toISOString()}.`
      : `Booking ${payload.bookingCode} đã được tạo.`;
    await this.createInAppSafely({
      userId: payload.userId,
      type: NotificationType.BOOKING_CREATED,
      title: "Booking đã được tạo",
      body,
      metadata: {
        idempotencyKey: `booking-created:${payload.bookingId}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
      },
    });
    this.invalidateReportCacheSafely("booking.created");
  }

  async notifyBookingCancelled(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId?: string;
    reason?: string;
  }): Promise<void> {
    await this.createInAppSafely({
      userId: payload.userId,
      type: NotificationType.BOOKING_CANCELLED,
      title: "Booking đã được hủy",
      body: `Booking ${payload.bookingCode} đã được hủy.${payload.reason ? ` Lý do: ${payload.reason}` : ""}`,
      metadata: {
        idempotencyKey: `booking-cancelled:${payload.bookingId}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
      },
    });
    this.invalidateReportCacheSafely("booking.cancelled");
  }

  async notifyPaymentSucceeded(payload: {
    userId: string | Types.ObjectId;
    bookingId?: string;
    bookingCode: string;
    eventId?: string;
    provider: string;
  }): Promise<void> {
    await this.createInAppSafely({
      userId: payload.userId,
      type: NotificationType.PAYMENT_SUCCEEDED,
      title: "Thanh toán thành công",
      body: `Thanh toán cho booking ${payload.bookingCode} đã thành công.`,
      metadata: {
        idempotencyKey: `payment-succeeded:${payload.bookingCode}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
        provider: payload.provider,
      },
    });
    this.invalidateReportCacheSafely("payment.succeeded");
  }

  async notifyTicketsIssued(payload: {
    userId: string | Types.ObjectId;
    bookingId?: string;
    bookingCode: string;
    eventId?: string;
  }): Promise<void> {
    await this.createInAppSafely({
      userId: payload.userId,
      type: NotificationType.TICKET_ISSUED,
      title: "Vé đã sẵn sàng",
      body: `Vé cho booking ${payload.bookingCode} đã được phát hành.`,
      metadata: {
        idempotencyKey: `ticket-issued:${payload.bookingCode}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
      },
    });
    this.invalidateReportCacheSafely("ticket.issued");
  }

  async notifyRefundRequested(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId: string;
    refundRequestId: string;
    amount: number;
  }): Promise<void> {
    await this.createInAppSafely({
      userId: payload.userId,
      type: NotificationType.REFUND_REQUESTED,
      title: "Yêu cầu hoàn tiền đã được tạo",
      body: `Yêu cầu hoàn tiền cho booking ${payload.bookingCode} đang chờ xử lý.`,
      metadata: {
        idempotencyKey: `refund-requested:${payload.refundRequestId}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
        refundRequestId: payload.refundRequestId,
      },
    });
  }

  async notifyRefundReviewed(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId: string;
    refundRequestId: string;
    approved: boolean;
    amount: number;
  }): Promise<void> {
    await this.createInAppSafely({
      userId: payload.userId,
      type: payload.approved
        ? NotificationType.REFUND_SUCCEEDED
        : NotificationType.REFUND_REJECTED,
      title: payload.approved
        ? "Hoàn tiền thành công"
        : "Yêu cầu hoàn tiền bị từ chối",
      body: payload.approved
        ? `Booking ${payload.bookingCode} đã được hoàn tiền.`
        : `Yêu cầu hoàn tiền cho booking ${payload.bookingCode} đã bị từ chối.`,
      metadata: {
        idempotencyKey: `${payload.approved ? "refund-succeeded" : "refund-rejected"}:${payload.refundRequestId}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
        refundRequestId: payload.refundRequestId,
      },
    });
    this.invalidateReportCacheSafely(
      payload.approved ? "refund.succeeded" : "refund.rejected"
    );
  }

  async notifyRefundFailed(payload: {
    userId: string | Types.ObjectId;
    bookingId: string;
    bookingCode: string;
    eventId: string;
    refundRequestId: string;
    amount: number;
    reason?: string;
  }): Promise<void> {
    await this.createInAppSafely({
      userId: payload.userId,
      type: NotificationType.REFUND_FAILED,
      title: "Hoàn tiền thất bại",
      body: `Hoàn tiền cho booking ${payload.bookingCode} chưa thành công. Bộ phận hỗ trợ sẽ kiểm tra lại.${payload.reason ? ` Lý do: ${payload.reason}` : ""}`,
      metadata: {
        idempotencyKey: `refund-failed:${payload.refundRequestId}`,
        bookingId: payload.bookingId,
        bookingCode: payload.bookingCode,
        eventId: payload.eventId,
        refundRequestId: payload.refundRequestId,
      },
    });
    this.invalidateReportCacheSafely("refund.failed");
  }
}
