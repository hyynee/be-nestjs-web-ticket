import { Types } from "mongoose";
import { EventCancellationJobStatus } from "@src/schemas/event-cancellation-job.schema";

export type EventCancellationFailureSource = {
  bookingId: Types.ObjectId;
  error: string;
  failedAt: Date;
};

export type EventCancellationJobSource = {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  initiatedBy: Types.ObjectId;
  reason: string;
  status: EventCancellationJobStatus;
  totalBookings: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  lastProcessedBookingId?: Types.ObjectId;
  failures: EventCancellationFailureSource[];
  startedAt?: Date;
  completedAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
};

export interface EventCancellationFailureView {
  bookingId: string;
  error: string;
  failedAt: string;
}

export interface CancelEventBookingsJobPayload {
  cancellationJobId: string;
}

export interface EventCancellationJobDetail {
  id: string;
  eventId: string;
  initiatedBy: string;
  reason: string;
  status: EventCancellationJobStatus;
  totalBookings: number;
  processedCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  failures: EventCancellationFailureView[];
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}
