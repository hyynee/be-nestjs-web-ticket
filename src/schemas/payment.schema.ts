// payment.schema.ts
import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

@Schema({ timestamps: true })
export class Payment extends Document {
  @Prop({ type: Types.ObjectId, ref: "Booking", required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ required: true })
  stripePaymentIntentId: string;

  @Prop({ type: Number, required: true, min: 0 })
  amount: number;

  @Prop({ type: String, default: "vnd" })
  currency: string;

  @Prop({
    type: String,
    enum: ["card", "bank_transfer", "e_wallet"],
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
    ],
    default: "pending",
  })
  status: string;

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({ type: Object })
  metadata?: Record<string, any>;

  @Prop({ type: Date })
  paidAt?: Date;

  @Prop({ type: Date })
  refundedAt?: Date;

  @Prop({ type: String })
  stripeRefundId?: string;

  @Prop({ type: Number })
  refundAmount?: number;

  // Soft delete
  @Prop({ default: false })
  isDeleted: boolean;
}

export const PaymentSchema = SchemaFactory.createForClass(Payment);

// Indexes
PaymentSchema.index({ bookingId: 1 });
PaymentSchema.index({ userId: 1 });
PaymentSchema.index({ stripePaymentIntentId: 1 });
PaymentSchema.index({ status: 1 });
PaymentSchema.index({ isDeleted: 1 });