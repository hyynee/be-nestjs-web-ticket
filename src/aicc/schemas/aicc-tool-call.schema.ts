import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument } from "mongoose";

export enum AiccToolCallStatus {
  SUCCESS = "success",
  FAILED = "failed",
}

export type AiccToolCallDocument = HydratedDocument<AiccToolCall>;

@Schema({ timestamps: true })
export class AiccToolCall {
  @Prop({ type: String, required: true })
  sessionId: string;

  @Prop({ type: Number, required: true, min: 1 })
  turnNo: number;

  @Prop({ type: String, required: true, trim: true })
  toolName: string;

  @Prop({ type: Object, default: {} })
  args: Record<string, unknown>;

  @Prop({ type: Object, default: {} })
  result: Record<string, unknown>;

  @Prop({
    type: String,
    enum: AiccToolCallStatus,
    required: true,
  })
  status: AiccToolCallStatus;

  @Prop({ type: String, trim: true })
  errorCode?: string;

  @Prop({ type: Number, required: true, min: 0 })
  durationMs: number;

  @Prop({ type: String, trim: true })
  idempotencyKey?: string;
}

export const AiccToolCallSchema = SchemaFactory.createForClass(AiccToolCall);

AiccToolCallSchema.index({ sessionId: 1, createdAt: -1 });
AiccToolCallSchema.index({ toolName: 1, status: 1, createdAt: -1 });
AiccToolCallSchema.index(
  { idempotencyKey: 1 },
  {
    unique: true,
    sparse: true,
    name: "idx_aicc_tool_idempotency_unique",
  }
);
