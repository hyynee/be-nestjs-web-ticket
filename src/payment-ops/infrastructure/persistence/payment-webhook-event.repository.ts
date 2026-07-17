import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  PaymentWebhookEvent,
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";
import { FilterQuery, Model, Types } from "mongoose";
import Stripe from "stripe";
import type { PaymentWebhookEventDocument } from "../../types/payment-ops-domain.types";

@Injectable()
export class PaymentWebhookEventRepository {
  constructor(
    @InjectModel(PaymentWebhookEvent.name)
    private readonly webhookEventModel: Model<PaymentWebhookEvent>
  ) {}

  upsertReceivedStripeEvent(
    event: Stripe.Event,
    payload: Record<string, unknown>
  ): Promise<PaymentWebhookEventDocument | null> {
    return this.webhookEventModel
      .findOneAndUpdate(
        { provider: PaymentWebhookProvider.STRIPE, eventId: event.id },
        {
          $setOnInsert: {
            provider: PaymentWebhookProvider.STRIPE,
            eventId: event.id,
            eventType: event.type,
            payload,
            status: PaymentWebhookEventStatus.RECEIVED,
            retryCount: 0,
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      )
      .lean<PaymentWebhookEventDocument>();
  }

  findByProviderEvent(
    provider: PaymentWebhookProvider,
    eventId: string
  ): Promise<PaymentWebhookEventDocument | null> {
    return this.webhookEventModel
      .findOne({ provider, eventId })
      .lean<PaymentWebhookEventDocument>();
  }

  async loadById(id: string): Promise<PaymentWebhookEventDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid webhook event ID");
    }

    const row = await this.webhookEventModel
      .findById(id)
      .lean<PaymentWebhookEventDocument>();
    if (!row) {
      throw new NotFoundException("Webhook event not found");
    }
    return row;
  }

  async findMany(
    filter: FilterQuery<PaymentWebhookEvent>,
    page: number,
    limit: number
  ): Promise<{ rows: PaymentWebhookEventDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      this.webhookEventModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<PaymentWebhookEventDocument[]>(),
      this.webhookEventModel.countDocuments(filter),
    ]);

    return { rows, total };
  }

  updateStatus(
    provider: PaymentWebhookProvider,
    eventId: string,
    update: Record<string, unknown>
  ): Promise<unknown> {
    return this.webhookEventModel.updateOne({ provider, eventId }, update);
  }

  markRetrying(id: Types.ObjectId): Promise<unknown> {
    return this.webhookEventModel.updateOne(
      { _id: id, status: PaymentWebhookEventStatus.FAILED },
      {
        $inc: { retryCount: 1 },
        $set: {
          status: PaymentWebhookEventStatus.PROCESSING,
          lastRetriedAt: new Date(),
        },
        $unset: { errorMessage: "" },
      }
    );
  }
}
