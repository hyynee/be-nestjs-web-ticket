import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

@Schema({ timestamps: true })
export class Payment extends Document {
  @Prop({ type: Types.ObjectId, ref: "Booking", required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Event" })
  eventId?: Types.ObjectId;

  @Prop({ type: String })
  stripePaymentIntentId?: string;

  @Prop({ type: String })
  paypalOrderId?: string;

  @Prop({ type: String })
  paypalCaptureId?: string;

  @Prop({ type: Number, required: true, min: 0 })
  amount: number;

  @Prop({ type: String, default: "vnd" })
  currency: string;

  @Prop({
    type: String,
    enum: ["card", "bank_transfer", "e_wallet", "paypal"],
    default: "card",
  })
  paymentMethod: string;

  @Prop({
    type: String,
    enum: [
      "pending",
      "processing",
      "succeeded",
      "failed",
      "canceled",
      "refunded",
      "partially_refunded",
    ],
    default: "pending",
  })
  status: string;

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({
    type: {
      sessionId: String,
      customerEmail: String,
      customerName: String,
      customerPhone: String,
      orderId: String,
      orderStatus: String,
      authorizationId: String,
      captureStatus: String,
      captureId: String,
      capturedAt: String,
      bookingCode: String,
      eventTitle: String,
      amountUSD: String,
      originalTotalPrice: Number,
      discountAmount: Number,
      promotionCode: String,
    },
    _id: false,
  })
  metadata?: {
    sessionId?: string;
    customerEmail?: string;
    customerName?: string;
    customerPhone?: string;
    orderId?: string;
    orderStatus?: string;
    authorizationId?: string;
    captureStatus?: string;
    captureId?: string;
    capturedAt?: string;
    bookingCode?: string;
    eventTitle?: string;
    amountUSD?: string;
    originalTotalPrice?: number;
    discountAmount?: number;
    promotionCode?: string;
  };

  @Prop({ type: Date })
  paidAt?: Date;

  @Prop({ type: Date })
  refundedAt?: Date;

  @Prop({ type: String })
  stripeRefundId?: string;

  @Prop({ type: String })
  paypalRefundId?: string;

  @Prop({ type: Number })
  refundAmount?: number;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

// Indexes
PaymentSchema.index({ bookingId: 1 });
PaymentSchema.index({ userId: 1 });
PaymentSchema.index({ stripePaymentIntentId: 1 });
PaymentSchema.index({ paypalOrderId: 1 });
PaymentSchema.index({ status: 1 });
PaymentSchema.index({ isDeleted: 1 });
PaymentSchema.index({ eventId: 1, status: 1, isDeleted: 1 });
PaymentSchema.index({ createdAt: -1 });
PaymentSchema.index({ status: 1, isDeleted: 1, createdAt: -1 });
PaymentSchema.index({ eventId: 1, status: 1, isDeleted: 1, createdAt: -1 });
// Revenue date-range queries in queryRevenueStatistics() filter on { eventId, createdAt }
PaymentSchema.index(
  { eventId: 1, createdAt: -1 },
  { name: "idx_event_created" }
);
PaymentSchema.index(
  { userId: 1, isDeleted: 1, createdAt: -1 },
  { name: "idx_user_deleted_created" }
);
PaymentSchema.index(
  { userId: 1, isDeleted: 1, status: 1, createdAt: -1 },
  { name: "idx_user_deleted_status_created" }
);
