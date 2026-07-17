import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum PromotionType {
  PERCENT = "percent",
  FIXED = "fixed",
}

@Schema({ timestamps: true })
export class Promotion extends Document {
  @Prop({ type: String, required: true, trim: true, uppercase: true })
  code: string;

  @Prop({ type: String, enum: PromotionType, required: true })
  type: PromotionType;

  @Prop({ type: Number, required: true, min: 1 })
  value: number;

  @Prop({ type: [Types.ObjectId], ref: "Event", default: [] })
  eventIds: Types.ObjectId[];

  @Prop({ type: [Types.ObjectId], ref: "Zone", default: [] })
  zoneIds: Types.ObjectId[];

  @Prop({ type: Date, required: true })
  startsAt: Date;

  @Prop({ type: Date, required: true })
  endsAt: Date;

  @Prop({ type: Number, min: 1 })
  maxUses?: number;

  @Prop({ type: Number, min: 1 })
  maxUsesPerUser?: number;

  @Prop({ type: Number, required: true, min: 0, default: 0 })
  usedCount: number;

  @Prop({ type: Number, min: 0 })
  minOrderAmount?: number;

  @Prop({ type: Boolean, default: true })
  isActive: boolean;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  createdBy: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;
}

export const PromotionSchema = SchemaFactory.createForClass(Promotion);

PromotionSchema.index({ code: 1 }, { unique: true });
PromotionSchema.index({ isActive: 1, startsAt: 1, endsAt: 1 });
PromotionSchema.index({ eventIds: 1, isActive: 1 });
PromotionSchema.index({ zoneIds: 1, isActive: 1 });
