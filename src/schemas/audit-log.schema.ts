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
