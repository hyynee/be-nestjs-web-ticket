import { PaymentWebhookEvent } from "@src/schemas/payment-webhook-event.schema";
import { Types } from "mongoose";

export type PaymentWebhookEventDocument = PaymentWebhookEvent & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};
