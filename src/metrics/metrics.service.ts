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

  readonly httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "HTTP request duration in seconds",
    labelNames: ["method", "route", "status_code"] as const,
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  readonly queueDepth = new Gauge({
    name: "queue_depth",
    help: "BullMQ queue job counts",
    labelNames: ["state"] as const,
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
