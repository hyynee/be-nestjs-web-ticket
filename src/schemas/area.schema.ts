import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

@Schema({ timestamps: true })
export class Area extends Document {
  @Prop({ type: Types.ObjectId, ref: "Event", required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Zone", required: true })
  zoneId: Types.ObjectId;

  @Prop({ required: true, maxlength: 100 })
  name: string;

  @Prop()
  description: string;

  @Prop({ default: false })
  isDeleted: boolean;

  @Prop({ type: String })
rowLabel?: string; 

@Prop({ type: Number })
seatCount?: number; 

@Prop([String])
seats?: string[];
}

export const AreaSchema = SchemaFactory.createForClass(Area);

// Index
AreaSchema.index({ eventId: 1, zoneId: 1 });
AreaSchema.index({ zoneId: 1, name: 1 }, { unique: true });
AreaSchema.index({ isDeleted: 1 });
