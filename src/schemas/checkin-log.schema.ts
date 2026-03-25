import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Types } from "mongoose";

@Schema({ timestamps: true })
export class CheckInLog {
  @Prop({ type: Types.ObjectId, ref: "Ticket", required: true, index: true })
  ticketId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  adminId: Types.ObjectId;

  @Prop()
  location: string;

  @Prop()
  deviceInfo: string;

  @Prop()
  ipAddress: string;

  @Prop({ default: true })
  success: boolean;

  @Prop()
  message: string;
}

export const CheckInLogSchema = SchemaFactory.createForClass(CheckInLog);
