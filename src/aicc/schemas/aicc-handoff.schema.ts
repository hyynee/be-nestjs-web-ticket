import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export enum AiccHandoffReason {
  HUMAN_REQUEST = "human_request",
  PAYMENT_ISSUE = "payment_issue",
  REFUND = "refund",
  COMPLAINT = "complaint",
  CHECKIN_ISSUE = "checkin_issue",
  AI_FAILED = "ai_failed",
  POLICY_SENSITIVE = "policy_sensitive",
}

export enum AiccHandoffPriority {
  LOW = "low",
  NORMAL = "normal",
  HIGH = "high",
}

export enum AiccHandoffStatus {
  OPEN = "open",
  PICKED = "picked",
  RESOLVED = "resolved",
  EXPIRED = "expired",
}

export type AiccHandoffDocument = HydratedDocument<AiccHandoff>;

@Schema({ timestamps: true })
export class AiccHandoff {
  @Prop({ type: String, required: true })
  sessionId: string;

  @Prop({ type: Types.ObjectId, ref: "User" })
  userId?: Types.ObjectId;

  @Prop({ type: String, lowercase: true, trim: true })
  customerEmail?: string;

  @Prop({ type: String, trim: true })
  customerPhone?: string;

  @Prop({
    type: String,
    enum: AiccHandoffReason,
    required: true,
  })
  reason: AiccHandoffReason;

  @Prop({
    type: String,
    enum: AiccHandoffPriority,
    default: AiccHandoffPriority.NORMAL,
    required: true,
  })
  priority: AiccHandoffPriority;

  @Prop({ type: String, required: true, trim: true, maxlength: 4000 })
  summary: string;

  @Prop({
    type: String,
    enum: AiccHandoffStatus,
    default: AiccHandoffStatus.OPEN,
    required: true,
  })
  status: AiccHandoffStatus;

  @Prop({ type: Types.ObjectId, ref: "User" })
  assignedTo?: Types.ObjectId;

  @Prop({ type: Date })
  pickedAt?: Date;

  @Prop({ type: Date })
  resolvedAt?: Date;

  @Prop({ type: String, trim: true, maxlength: 2000 })
  resolutionNote?: string;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const AiccHandoffSchema = SchemaFactory.createForClass(AiccHandoff);

AiccHandoffSchema.index({ status: 1, priority: 1, createdAt: -1 });
AiccHandoffSchema.index({ sessionId: 1 });
AiccHandoffSchema.index({ assignedTo: 1, status: 1 });
