import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum SeatBlockStatus {
  BLOCKED = "blocked",
  DISABLED = "disabled",
}

/** Admin/organizer override of a seat's bookability — takes priority over the computed holding/sold state. */
@Schema({ timestamps: true })
export class SeatState extends Document {
  @Prop({ type: Types.ObjectId, ref: "Event", required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Zone", required: true })
  zoneId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Area", required: true })
  areaId: Types.ObjectId;

  @Prop({ type: String, required: true })
  seat: string;

  @Prop({ type: String, enum: SeatBlockStatus, required: true })
  status: SeatBlockStatus;

  @Prop({ type: String })
  reason?: string;

  @Prop({ type: Types.ObjectId, ref: "User" })
  createdBy?: Types.ObjectId;

  @Prop({ type: Date })
  expiresAt?: Date;
}

export const SeatStateSchema = SchemaFactory.createForClass(SeatState);

SeatStateSchema.index(
  { eventId: 1, zoneId: 1, areaId: 1, seat: 1 },
  { unique: true }
);
// sparse: true — only documents with an expiresAt are subject to TTL cleanup;
// permanent blocks (no expiresAt) live until explicitly unblocked.
SeatStateSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, sparse: true }
);
