import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { HydratedDocument, Types } from "mongoose";

export enum AiccKnowledgeCategory {
  EVENT_POLICY = "event_policy",
  PAYMENT_POLICY = "payment_policy",
  REFUND_POLICY = "refund_policy",
  CHECKIN_POLICY = "checkin_policy",
  FAQ = "faq",
  PROMOTION = "promotion",
  SUPPORT_SCRIPT = "support_script",
}

export enum AiccKnowledgeStatus {
  DRAFT = "draft",
  ACTIVE = "active",
  ARCHIVED = "archived",
}

export type AiccKnowledgeDocument = HydratedDocument<AiccKnowledge>;

@Schema({ timestamps: true })
export class AiccKnowledge {
  @Prop({ type: String, required: true, trim: true, maxlength: 200 })
  title: string;

  @Prop({
    type: String,
    enum: AiccKnowledgeCategory,
    required: true,
  })
  category: AiccKnowledgeCategory;

  @Prop({ type: String, required: true, trim: true, maxlength: 12000 })
  content: string;

  @Prop({
    type: String,
    enum: AiccKnowledgeStatus,
    default: AiccKnowledgeStatus.DRAFT,
    required: true,
  })
  status: AiccKnowledgeStatus;

  @Prop({ type: Number, required: true, min: 1, default: 1 })
  version: number;

  @Prop({ type: Date })
  effectiveFrom?: Date;

  @Prop({ type: Types.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;

  @Prop({ type: Object, default: {} })
  metadata: Record<string, unknown>;
}

export const AiccKnowledgeSchema = SchemaFactory.createForClass(AiccKnowledge);

AiccKnowledgeSchema.index({
  title: "text",
  content: "text",
  category: "text",
});
AiccKnowledgeSchema.index({ status: 1, category: 1, updatedAt: -1 });
AiccKnowledgeSchema.index({ effectiveFrom: 1 });
