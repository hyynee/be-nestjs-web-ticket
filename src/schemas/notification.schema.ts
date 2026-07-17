import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum NotificationType {
  REGISTER_SUCCESS = "register_success",
  EMAIL_VERIFICATION = "email_verification",
  PASSWORD_RESET_REQUESTED = "password_reset_requested",
  BOOKING_CREATED = "booking_created",
  BOOKING_EXPIRY_REMINDER = "booking_expiry_reminder",
  BOOKING_CANCELLED = "booking_cancelled",
  PAYMENT_SUCCEEDED = "payment_succeeded",
  PAYMENT_FAILED = "payment_failed",
  TICKET_ISSUED = "ticket_issued",
  EVENT_REMINDER = "event_reminder",
  REFUND_REQUESTED = "refund_requested",
  REFUND_APPROVED = "refund_approved",
  REFUND_REJECTED = "refund_rejected",
  REFUND_SUCCEEDED = "refund_succeeded",
  REFUND_FAILED = "refund_failed",
  EVENT_CANCELLED = "event_cancelled",
}

export enum NotificationChannel {
  EMAIL = "email",
  IN_APP = "in_app",
}

export enum NotificationStatus {
  QUEUED = "queued",
  SENT = "sent",
  FAILED = "failed",
  READ = "read",
}

@Schema({ timestamps: true })
export class Notification extends Document {
  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: String, enum: NotificationType, required: true })
  type: NotificationType;

  @Prop({ type: String, enum: NotificationChannel, required: true })
  channel: NotificationChannel;

  @Prop({ type: String, required: true, trim: true, maxlength: 180 })
  title: string;

  @Prop({ type: String, required: true, trim: true, maxlength: 4000 })
  body: string;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({
    type: String,
    enum: NotificationStatus,
    default: NotificationStatus.QUEUED,
  })
  status: NotificationStatus;

  @Prop({ type: String, trim: true, lowercase: true })
  recipientEmail?: string;

  @Prop({ type: Date })
  sentAt?: Date;

  @Prop({ type: Date })
  readAt?: Date;

  @Prop({ type: String, maxlength: 1000 })
  errorMessage?: string;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);

NotificationSchema.index(
  { userId: 1, createdAt: -1 },
  { name: "idx_notification_user_created" }
);
NotificationSchema.index(
  { userId: 1, status: 1, createdAt: -1 },
  { name: "idx_notification_user_status_created" }
);
NotificationSchema.index(
  { type: 1, createdAt: -1 },
  { name: "idx_notification_type_created" }
);
NotificationSchema.index(
  { "metadata.idempotencyKey": 1 },
  {
    unique: true,
    sparse: true,
    name: "uniq_notification_idempotency_key",
  }
);
