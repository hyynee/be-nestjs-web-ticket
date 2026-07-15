import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum AuditAction {
  BOOKING_CANCEL = "booking.cancel",
  BOOKING_ADMIN_CANCEL = "booking.admin_cancel",
  TICKET_CANCEL = "ticket.cancel",
  TICKET_CHECKIN = "ticket.checkin",
  EVENT_CANCEL = "event.cancel",
  REFUND_ISSUED = "refund.issued",
  REFUND_FAILED = "refund.failed",
  QUEUE_JOB_ADD = "queue.job_add",
  QUEUE_JOB_RETRY = "queue.job_retry",
  QUEUE_JOB_DEAD_LETTER = "queue.job_dead_letter",
  QUEUE_JOB_REMOVE = "queue.job_remove",
  EVENT_ORGANIZER_ADD = "event.organizer_add",
  EVENT_ORGANIZER_REMOVE = "event.organizer_remove",
  EVENT_STAFF_ADD = "event.staff_add",
  EVENT_STAFF_REMOVE = "event.staff_remove",
  EVENT_PUBLISH = "event.publish",
  EVENT_UNPUBLISH = "event.unpublish",
  EVENT_END = "event.end",
}

@Schema({ timestamps: true })
export class AuditLog extends Document {
  @Prop({ type: String, enum: AuditAction, required: true })
  action: AuditAction;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  actorId: Types.ObjectId;

  @Prop({ type: String })
  actorRole?: string;

  @Prop({ type: Types.ObjectId, ref: "Booking" })
  bookingId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Event" })
  eventId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Ticket" })
  ticketId?: Types.ObjectId;

  @Prop({ type: Object })
  metadata?: Record<string, unknown>;

  @Prop({ type: String })
  reason?: string;

  @Prop({ type: String })
  ipAddress?: string;
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

AuditLogSchema.index({ actorId: 1, createdAt: -1 });
AuditLogSchema.index({ action: 1, createdAt: -1 });
AuditLogSchema.index({ bookingId: 1 });
AuditLogSchema.index({ eventId: 1 });
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ ticketId: 1, createdAt: -1 });
AuditLogSchema.index({ eventId: 1, action: 1, createdAt: -1 });
