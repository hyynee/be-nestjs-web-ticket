import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

@Schema({ timestamps: true })
export class Booking extends Document {
  // Mã booking unique để tracking
  @Prop({ required: true, unique: true })
  bookingCode: string; // VD: BK20240101001

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Event", required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Zone", required: true })
  zoneId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Area" })
  areaId?: Types.ObjectId;

  @Prop({ type: [String], default: [] })
  seats: string[];

  @Prop({ type: Number, required: true, min: 1 })
  quantity: number;

  @Prop({ type: Number, required: true, min: 0 })
  pricePerTicket: number;

  @Prop({ type: Number, required: true, min: 0 })
  totalPrice: number;

  // Trạng thái booking
  @Prop({
    type: String,
    enum: ["pending", "confirmed", "cancelled", "expired"],
    default: "pending",
  })
  status: "pending" | "confirmed" | "cancelled" | "expired";

  @Prop({
    type: String,
    enum: ["unpaid", "paid", "refunded"],
    default: "unpaid",
  })
  paymentStatus: "unpaid" | "paid" | "refunded";

  @Prop({ type: String })
  stripePaymentIntentId?: string;

  // Thời gian hết hạn giữ vé (15 phút từ lúc tạo)
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

  @Prop({ type: String })
  cancellationReason?: string;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const BookingSchema = SchemaFactory.createForClass(Booking);

// check booking còn hợp lệ không
BookingSchema.virtual("isExpired").get(function () {
  return new Date() > this.expiresAt && this.status === "pending";
});

// check có thể hủy không (chưa thanh toán hoặc còn thời gian)
BookingSchema.virtual("canCancel").get(function () {
  return this.status === "confirmed" && this.paymentStatus === "paid";
});

BookingSchema.index({ userId: 1, createdAt: -1 }); 
BookingSchema.index({ bookingCode: 1 }, { unique: true }); 
BookingSchema.index({ eventId: 1 }); 
BookingSchema.index({ status: 1, expiresAt: 1 }); 
BookingSchema.index({ stripePaymentIntentId: 1 }); 
BookingSchema.index({ isDeleted: 1 });

// Pre-save: Tự động tính expiresAt (15 phút)
BookingSchema.pre<Booking>("save", function (next) {
  if (this.isNew && !this.expiresAt) {
    this.expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 phút
  }
  next();
});