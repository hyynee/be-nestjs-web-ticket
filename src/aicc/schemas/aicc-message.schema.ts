import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export enum AiccMessageSpeaker {
  CUSTOMER = "customer",
  AI = "ai",
  AGENT = "agent",
  SYSTEM = "system",
}

export type AiccMessageDocument = HydratedDocument<AiccMessage>;

@Schema({ timestamps: true })
export class AiccMessage {
  @Prop({ type: String, required: true, index: true })
  sessionId: string;

  @Prop({ type: Number, required: true, min: 1 })
  turnNo: number;

  @Prop({
    type: String,
    enum: AiccMessageSpeaker,
    required: true,
  })
  speaker: AiccMessageSpeaker;

  @Prop({ type: String, required: true, trim: true, maxlength: 4000 })
  text: string;

  @Prop({ type: String, trim: true })
  intent?: string;

  @Prop({ type: Object, default: {} })
  entities: Record<string, unknown>;

  @Prop({ type: Number, min: 0, max: 1 })
  confidence?: number;

  @Prop({ type: Number, min: 0 })
  latencyMs?: number;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const AiccMessageSchema = SchemaFactory.createForClass(AiccMessage);

AiccMessageSchema.index(
  { sessionId: 1, turnNo: 1, speaker: 1 },
  { unique: true, name: "idx_aicc_message_turn_speaker_unique" }
);
AiccMessageSchema.index({ sessionId: 1, createdAt: 1 });
