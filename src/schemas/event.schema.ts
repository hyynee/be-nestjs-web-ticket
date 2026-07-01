import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";
import { User } from "./user.schema";

export enum EventStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  INACTIVE = "inactive",
  ENDED = "ended",
  CANCELLED = "cancelled",
}

@Schema({ _id: true })
export class TimeSlot {
  _id: Types.ObjectId;

  @Prop({ type: String, required: true })
  label: string;

  @Prop({ type: Date, required: true })
  startTime: Date;

  @Prop({ type: Date, required: true })
  endTime: Date;

  @Prop({ type: Number, min: 1 })
  capacity?: number;
}

export const TimeSlotSchema = SchemaFactory.createForClass(TimeSlot);

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
    enum: EventStatus,
    default: EventStatus.DRAFT,
  })
  status: EventStatus;

  @Prop({ type: [TimeSlotSchema], default: [] })
  timeSlots: TimeSlot[];

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  createdBy: User;

  @Prop({ type: Types.ObjectId, ref: "User" })
  updatedBy?: User;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: Date })
  deletedAt?: Date;
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
EventSchema.index({ createdAt: -1 });
EventSchema.index({ status: 1, isDeleted: 1 }, { name: "idx_status_deleted" });
EventSchema.index(
  { status: 1, isDeleted: 1, createdAt: -1 },
  { name: "idx_status_deleted_created" }
);
EventSchema.index(
  { title: "text", description: "text", location: "text" },
  { name: "idx_text_search" }
);
