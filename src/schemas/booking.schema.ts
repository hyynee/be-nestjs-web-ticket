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
