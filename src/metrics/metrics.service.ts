import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  Registry,
} from "prom-client";

@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  readonly bookingsTotal = new Counter({
    name: "bookings_total",
    help: "Total number of booking attempts",
    labelNames: ["status"] as const,
    registers: [this.registry],
  });

  readonly paymentsTotal = new Counter({
    name: "payments_total",
    help: "Total payment events",
    labelNames: ["provider", "status"] as const,
    registers: [this.registry],
  });

  readonly refundFailuresTotal = new Counter({
    name: "refund_failures_total",
    help: "Number of refund failures requiring manual intervention",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly checkinsTotal = new Counter({
    name: "checkins_total",
    help: "Total ticket check-in attempts",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  readonly bookingConflictTotal = new Counter({
    name: "booking_conflict_total",
    help: "Number of booking attempts that hit a seat conflict or capacity exhaustion",
    registers: [this.registry],
  });

  readonly zoneCapacityInconsistentTotal = new Counter({
    name: "zone_capacity_inconsistent_total",
    help: "Number of times a zone capacity conditional update failed to match, indicating counter drift",
    labelNames: ["direction"] as const,
    registers: [this.registry],
  });

  readonly cacheInvalidationFailureTotal = new Counter({
    name: "cache_invalidation_failure_total",
    help: "Number of times a post-commit cache invalidation call failed",
    labelNames: ["source"] as const,
    registers: [this.registry],
  });

  readonly redisOperationFailureTotal = new Counter({
    name: "redis_operation_failure_total",
    help: "Number of times a Redis operation in the booking creation path failed or errored",
    labelNames: ["operation"] as const,
    registers: [this.registry],
  });

  readonly notificationFailuresTotal = new Counter({
    name: "notification_failures_total",
    help: "Number of notification deliveries lost to a genuine (non-duplicate-key) failure",
    labelNames: ["channel"] as const,
    registers: [this.registry],
  });

  readonly eventCancellationBookingsTotal = new Counter({
    name: "event_cancellation_bookings_total",
    help: "Per-booking outcomes while processing a bulk event-cancellation job",
    labelNames: ["result"] as const,
    registers: [this.registry],
  });

  readonly httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly queueDepth = new Gauge({
    name: "queue_depth",
    help: "BullMQ queue job counts, polled periodically by QueueService.reportQueueDepth",
    labelNames: ["queue", "state"] as const,
    registers: [this.registry],
  });

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }
}
