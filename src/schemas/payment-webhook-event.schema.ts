import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document } from "mongoose";

export enum PaymentWebhookProvider {
  STRIPE = "stripe",
  PAYPAL = "paypal",
}

export enum PaymentWebhookEventStatus {
  RECEIVED = "received",
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  IGNORED = "ignored",
}

@Schema({ timestamps: true })
export class PaymentWebhookEvent extends Document {
  @Prop({ type: String, enum: PaymentWebhookProvider, required: true })
  provider: PaymentWebhookProvider;

  @Prop({ type: String, required: true })
  eventId: string;

  @Prop({ type: String, required: true })
  eventType: string;

  @Prop({
    type: String,
    enum: PaymentWebhookEventStatus,
    default: PaymentWebhookEventStatus.RECEIVED,
  })
  status: PaymentWebhookEventStatus;

  @Prop({ type: Object, required: true })
  payload: Record<string, unknown>;

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({ type: Date })
  processedAt?: Date;

  @Prop({ type: Number, default: 0, min: 0 })
  retryCount: number;

  @Prop({ type: Date })
  lastRetriedAt?: Date;
}

export const PaymentWebhookEventSchema =
  SchemaFactory.createForClass(PaymentWebhookEvent);

PaymentWebhookEventSchema.index(
  { provider: 1, eventId: 1 },
  { unique: true, name: "uniq_payment_webhook_provider_event" }
);
PaymentWebhookEventSchema.index(
  { status: 1, createdAt: -1 },
  { name: "idx_payment_webhook_status_created" }
);
PaymentWebhookEventSchema.index(
  { eventType: 1, createdAt: -1 },
  { name: "idx_payment_webhook_type_created" }
);
