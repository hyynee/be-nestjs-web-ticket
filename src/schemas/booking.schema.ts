import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum BookingStatus {
  PENDING = "pending",
  CONFIRMED = "confirmed",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

export enum PaymentStatus {
  UNPAID = "unpaid",
  PAID = "paid",
  REFUND_PENDING = "refund_pending",
  REFUNDED = "refunded",
}

@Schema({ timestamps: true })
export class SeatLock extends Document {
  @Prop({ type: Types.ObjectId, required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, required: true })
  areaId: Types.ObjectId;

  @Prop({ type: String, required: true })
  seat: string;

  @Prop({ type: Types.ObjectId, ref: "Booking", required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Date, required: true, expires: 0 })
  expiresAt: Date;
}

export const SeatLockSchema = SchemaFactory.createForClass(SeatLock);
SeatLockSchema.index({ eventId: 1, areaId: 1, seat: 1 }, { unique: true });

/**
 * Immutable copy of event/zone/area facts as they were at booking time.
 * Populated once in BookingService.createBooking() and never touched again —
 * later edits to the Event/Zone/Area documents (title, price, dates, ...)
 * must not change how a past booking reads. Absent on bookings created
 * before this field existed; consumers fall back to populating
 * eventId/zoneId/areaId live for those.
 */
@Schema({ _id: false })
export class BookingSnapshot {
  @Prop({ type: String, required: true })
  eventTitle: string;

  @Prop({ type: Date, required: true })
  eventStartDate: Date;

  @Prop({ type: Date, required: true })
  eventEndDate: Date;

  @Prop({ type: String, required: true })
  location: string;

  @Prop({ type: String, required: true })
  zoneName: string;

  @Prop({ type: String })
  areaName?: string;

  @Prop({ type: [String] })
  seats?: string[];

  @Prop({ type: Number, required: true, min: 0 })
  pricePerTicket: number;

  @Prop({ type: String, required: true })
  currency: string;
}

export const BookingSnapshotSchema =
  SchemaFactory.createForClass(BookingSnapshot);

@Schema({ timestamps: true })
export class Booking extends Document {
  @Prop({ required: true, unique: true })
  bookingCode: string;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Event", required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Zone", required: true })
  zoneId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Area" })
  areaId?: Types.ObjectId;

  @Prop({ type: Types.ObjectId })
  timeSlotId?: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  seats: string[];

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;

  @Prop({ type: Number, required: true, min: 0 })
  pricePerTicket: number;

  @Prop({ type: Number, required: true, min: 0 })
  totalPrice: number;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  originalTotalPrice: number;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  discountAmount: number;

  @Prop({ type: String, trim: true, uppercase: true })
  promotionCode?: string;

  @Prop({ type: Types.ObjectId, ref: "Promotion" })
  promotionId?: Types.ObjectId;

  @Prop({ type: BookingSnapshotSchema })
  snapshot?: BookingSnapshot;

  @Prop({
    type: String,
    enum: BookingStatus,
    default: BookingStatus.PENDING,
  })
  status: BookingStatus;

  @Prop({
    type: String,
    enum: PaymentStatus,
    default: PaymentStatus.UNPAID,
  })
  paymentStatus: PaymentStatus;

  @Prop({ type: String })
  stripePaymentIntentId?: string;

  @Prop({ type: Date, required: true })
  expiresAt: Date;

  @Prop({ type: String, required: true })
  customerEmail: string;

  @Prop({ type: String })
  customerName?: string;

  @Prop({ type: String })
  customerPhone?: string;

  @Prop({ type: String })
  notes?: string;

  @Prop({ type: Date })
  paidAt?: Date;

  @Prop({ type: Date })
  cancelledAt?: Date;

  @Prop({ type: Types.ObjectId, ref: "User" })
  cancelledBy?: Types.ObjectId;

  @Prop({ type: String })
  cancellationReason?: string;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;

  @Prop({ type: Number, default: 0 })
  totalRefunded: number;

  @Prop({ type: [{ amount: Number, refundedAt: Date }], default: [] })
  refundHistory: Array<{ amount: number; refundedAt: Date }>;

  @Prop({ type: String })
  disputeId?: string;

  @Prop({ type: String })
  disputeReason?: string;

  @Prop({ type: String, enum: ["open", "under_review", "won", "lost"] })
  disputeStatus?: string;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

BookingSchema.virtual("isExpired").get(function () {
  return new Date() > this.expiresAt && this.status === "pending";
});

BookingSchema.index({ userId: 1, createdAt: -1 });
BookingSchema.index({ userId: 1, status: 1, isDeleted: 1, createdAt: -1 });
BookingSchema.index({ eventId: 1 });
BookingSchema.index({ eventId: 1, zoneId: 1, status: 1 });
BookingSchema.index({ status: 1, expiresAt: 1 });
BookingSchema.index({ stripePaymentIntentId: 1 });
BookingSchema.index({ isDeleted: 1 });
BookingSchema.index({ paymentStatus: 1, isDeleted: 1 });
BookingSchema.index({ promotionId: 1, isDeleted: 1 });
BookingSchema.index({ promotionCode: 1, isDeleted: 1 });
BookingSchema.index(
  { status: 1, expiresAt: 1, isDeleted: 1 },
  { name: "idx_expiry_cleanup" }
);
BookingSchema.index(
  { userId: 1, isDeleted: 1, createdAt: -1 },
  { name: "idx_user_deleted_created" }
);
BookingSchema.index(
  { userId: 1, eventId: 1, status: 1, isDeleted: 1 },
  { name: "idx_user_event_status_deleted" }
);
BookingSchema.index(
  { eventId: 1, zoneId: 1, areaId: 1, isDeleted: 1 },
  {
    partialFilterExpression: { status: { $eq: BookingStatus.PENDING } },
    name: "idx_pending_seats_lookup",
  }
);
// sparse: true — chỉ index documents có timeSlotId (events không dùng slots không bị ảnh hưởng)
BookingSchema.index(
  { timeSlotId: 1, status: 1 },
  { sparse: true, name: "idx_timeslot_status" }
);
