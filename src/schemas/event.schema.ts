import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";
import { User } from "./user.schema";

@Schema({ timestamps: true })
export class Event extends Document {
  @Prop({ required: true })
  title: string;

  @Prop({ type: String })
  description: string;

  @Prop({ type: Date, required: true })
  startDate: Date;

  @Prop({ type: Date, required: true })
  endDate: Date;

  @Prop({ type: String, required: true })
  location: string;

  @Prop({ type: String })
  thumbnail: string;

  @Prop({
    type: String,
    enum: ["draft", "active", "inactive", "ended"],
    default: "draft",
  })
  status: "draft" | "active" | "inactive" | "ended";

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  createdBy: User;

  @Prop({ type: Types.ObjectId, ref: "User" })
  updatedBy?: User;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const EventSchema = SchemaFactory.createForClass(Event);

EventSchema.virtual("isActiveNow").get(function () {
  const now = new Date();
  return (
    this.status === "active" && now >= this.startDate && now <= this.endDate
  );
});

EventSchema.index({ createdBy: 1 });
EventSchema.index({ status: 1 });
EventSchema.index({ startDate: 1 });
EventSchema.index({ isDeleted: 1 });
