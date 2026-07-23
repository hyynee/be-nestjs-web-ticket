import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { Document, Types } from "mongoose";

export enum EventCancellationJobStatus {
  PENDING = "pending",
  PROCESSING = "processing",
  COMPLETED = "completed",
  COMPLETED_WITH_ERRORS = "completed_with_errors",
}

export class EventCancellationFailure {
  @Prop({ type: Types.ObjectId, required: true })
  bookingId: Types.ObjectId;

  @Prop({ type: String, required: true })
  error: string;

  @Prop({ type: Date, required: true })
  failedAt: Date;
}

const EventCancellationFailureSchema = SchemaFactory.createForClass(
  EventCancellationFailure
);

/**
 * Durable, pollable record of one "cancel this event and refund every
 * booking" run (production-readiness-audit-2026-07-22.md NEW#6). Exists so
 * the HTTP request that triggers cancellation can return immediately —
 * `lastProcessedBookingId` is the resume checkpoint a retried/resumed queue
 * job continues from instead of reprocessing already-cancelled bookings.
 */
@Schema({ timestamps: true })
export class EventCancellationJob extends Document {
  @Prop({ type: Types.ObjectId, ref: "Event", required: true, index: true })
  eventId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: "User", required: true })
  initiatedBy: Types.ObjectId;

  @Prop({ type: String, required: true, trim: true, maxlength: 1000 })
  reason: string;

  @Prop({
    type: String,
    enum: EventCancellationJobStatus,
    default: EventCancellationJobStatus.PENDING,
  })
  status: EventCancellationJobStatus;

  @Prop({ type: Number, required: true, min: 0 })
  totalBookings: number;

  @Prop({ type: Number, default: 0, min: 0 })
  processedCount: number;

  @Prop({ type: Number, default: 0, min: 0 })
  succeededCount: number;

  @Prop({ type: Number, default: 0, min: 0 })
  failedCount: number;

  @Prop({ type: Number, default: 0, min: 0 })
  skippedCount: number;

  /** Resume checkpoint: last booking `_id` processed by the current cursor scan. */
  @Prop({ type: Types.ObjectId })
  lastProcessedBookingId?: Types.ObjectId;

  /** Capped sample of failures for admin visibility — not every failure over a large event, see EVENT_CANCELLATION_FAILURE_LOG_CAP. */
  @Prop({ type: [EventCancellationFailureSchema], default: [] })
  failures: EventCancellationFailure[];

  @Prop({ type: String })
  queueJobId?: string;

  @Prop({ type: Date })
  startedAt?: Date;

  @Prop({ type: Date })
  completedAt?: Date;

  @Prop({ default: false })
  isDeleted: boolean;
}

export const EventCancellationJobSchema =
  SchemaFactory.createForClass(EventCancellationJob);

EventCancellationJobSchema.index(
  { eventId: 1, createdAt: -1 },
  { name: "idx_event_cancellation_job_event_created" }
);
