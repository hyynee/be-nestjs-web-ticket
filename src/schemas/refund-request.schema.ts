import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum RefundRequestStatus {
  REQUESTED = "requested",
  PROCESSING = "processing",
  SUCCEEDED = "succeeded",
  FAILED = "failed",
  REJECTED = "rejected",
  /**
   * The provider (Stripe/PayPal) refund call succeeded — money already
   * moved — but the follow-up DB finalize (cancel booking/tickets, release
   * zone inventory, mark this request SUCCEEDED) failed before committing.
   * Distinct from FAILED (provider never charged/refunded) so retry() MUST
   * NOT re-issue a second provider refund for a request in this state —
   * only ReviewRefundRequestUseCase.reconcile() may resume it, which only
   * re-attempts the DB-side finalize.
   */
  RECONCILIATION_REQUIRED = "reconciliation_required",
}

export enum RefundProvider {
  STRIPE = "stripe",
  PAYPAL = "paypal",
}

@Schema({ timestamps: true })
export class RefundRequest extends Document {
  @Prop({ type: Types.ObjectId, ref: "Booking", required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  userId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "Event", required: true })
  eventId: Types.ObjectId;

  @Prop({ type: Number, required: true, min: 1 })
  amount: number;

  @Prop({ type: String, required: true, trim: true, maxlength: 1000 })
  reason: string;

  @Prop({
    type: String,
    enum: RefundRequestStatus,
    default: RefundRequestStatus.REQUESTED,
  })
  status: RefundRequestStatus;

  @Prop({ type: Types.ObjectId, ref: "User" })
  reviewedBy?: Types.ObjectId;

  @Prop({ type: Date })
  reviewedAt?: Date;

  @Prop({ type: String, enum: RefundProvider })
  provider?: RefundProvider;

  @Prop({ type: String })
  providerRefundId?: string;

  @Prop({ type: String })
  failureReason?: string;

  @Prop({ type: Object })
  metadata?: Record<string, string | number | boolean | Date | null>;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const RefundRequestSchema = SchemaFactory.createForClass(RefundRequest);

RefundRequestSchema.index(
  { bookingId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      status: {
        $in: [
          RefundRequestStatus.REQUESTED,
          RefundRequestStatus.PROCESSING,
          RefundRequestStatus.FAILED,
          RefundRequestStatus.RECONCILIATION_REQUIRED,
        ],
      },
      isDeleted: { $eq: false },
    },
    name: "uniq_active_refund_request_per_booking",
  }
);
RefundRequestSchema.index(
  { userId: 1, status: 1, createdAt: -1 },
  { name: "idx_refund_user_status_created" }
);
RefundRequestSchema.index(
  { eventId: 1, status: 1, createdAt: -1 },
  { name: "idx_refund_event_status_created" }
);
RefundRequestSchema.index(
  { status: 1, createdAt: -1 },
  { name: "idx_refund_status_created" }
);
