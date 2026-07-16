import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export enum AiccChannel {
  CHAT = "chat",
  VOICE = "voice",
  ZALO = "zalo",
  MESSENGER = "messenger",
}

export enum AiccSessionStatus {
  ACTIVE = "active",
  COMPLETED = "completed",
  HANDOFF = "handoff",
  ABANDONED = "abandoned",
}

export enum AiccSessionPhase {
  GREETING = "greeting",
  IDENTIFY_INTENT = "identify_intent",
  COLLECTING = "collecting",
  CONFIRMING = "confirming",
  EXECUTING = "executing",
  CLOSING = "closing",
}

export enum AiccOutcome {
  EVENT_INFO = "event_info",
  BOOKING_SUPPORT = "booking_support",
  PAYMENT_SUPPORT = "payment_support",
  TICKET_SUPPORT = "ticket_support",
  HANDOFF = "handoff",
  UNKNOWN = "unknown",
}

export type AiccSessionMetadata = Record<string, unknown> & {
  eventId?: string;
  bookingId?: string;
  ticketId?: string;
  paymentId?: string;
};

export type AiccSessionDocument = HydratedDocument<AiccSession>;

@Schema({ timestamps: true })
export class AiccSession {
  @Prop({ type: String, required: true, unique: true, index: true })
  sessionId: string;

  @Prop({
    type: String,
    enum: AiccChannel,
    default: AiccChannel.CHAT,
    required: true,
  })
  channel: AiccChannel;

  @Prop({ type: Types.ObjectId, ref: "User" })
  userId?: Types.ObjectId;

  @Prop({ type: String, lowercase: true, trim: true })
  customerEmail?: string;

  @Prop({ type: String, trim: true })
  customerPhone?: string;

  @Prop({
    type: String,
    enum: AiccSessionStatus,
    default: AiccSessionStatus.ACTIVE,
    required: true,
  })
  status: AiccSessionStatus;

  @Prop({ type: String, trim: true })
  currentIntent?: string;

  @Prop({
    type: String,
    enum: AiccSessionPhase,
    default: AiccSessionPhase.GREETING,
    required: true,
  })
  phase: AiccSessionPhase;

  @Prop({ type: String, trim: true, maxlength: 4000 })
  summary?: string;

  @Prop({ type: String, enum: AiccOutcome })
  outcome?: AiccOutcome;

  @Prop({ type: Object, default: {} })
  metadata: AiccSessionMetadata;

  @Prop({ type: Number, default: 1, min: 1, required: true })
  nextTurnNo: number;

  @Prop({ type: Date, default: Date.now, required: true })
  startedAt: Date;

  @Prop({ type: Date })
  endedAt?: Date;
}

export const AiccSessionSchema = SchemaFactory.createForClass(AiccSession);

AiccSessionSchema.index({ userId: 1, createdAt: -1 });
AiccSessionSchema.index({ status: 1, createdAt: -1 });
AiccSessionSchema.index({ channel: 1, createdAt: -1 });
