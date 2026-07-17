import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

@Schema({ timestamps: true })
export class PromotionUsage extends Document {
  @Prop({ type: Types.ObjectId, ref: "Promotion", required: true })
  promotionId: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, uppercase: true })
  code: string;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Booking", required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 0 })
  discountAmount: number;

  @Prop({ type: Number, required: true, min: 1 })
  usageOrdinal: number;

  @Prop({ type: Date })
  releasedAt?: Date;
}

export const PromotionUsageSchema =
  SchemaFactory.createForClass(PromotionUsage);

PromotionUsageSchema.index({ promotionId: 1, userId: 1 });
PromotionUsageSchema.index({ bookingId: 1 }, { unique: true });
PromotionUsageSchema.index(
  { promotionId: 1, userId: 1, usageOrdinal: 1 },
  { unique: true }
);
