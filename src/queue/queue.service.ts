import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { randomUUID } from "crypto";

export const FAILED_JOB_RETAIN_COUNT = 1000;
export const FAILED_JOB_ALERT_THRESHOLD = 100;

@Injectable()
export class QueueService {
  constructor(@InjectQueue("default") private readonly queue: Queue) {}

  async getJobCounts() {
    return this.queue.getJobCounts("active", "waiting", "failed", "delayed");
  }

  async addJob(data: {
    type: string;
    payload?: unknown;
    [key: string]: unknown;
  }) {
    const isRefundAlert = data.type === "refund-failure-alert";
    const jobId = this.buildJobId(data);

    return this.queue.add("default", data, {
      ...(jobId ? { jobId } : {}),
      attempts: isRefundAlert ? 6 : 3,
      priority: isRefundAlert ? 1 : 10,
      backoff: {
        type: "exponential",
        delay: isRefundAlert ? 10_000 : 5_000,
      },
      removeOnComplete: { count: 100 },
      removeOnFail: { count: FAILED_JOB_RETAIN_COUNT },
    });
  }

  private buildJobId(data: {
    type: string;
    payload?: unknown;
  }): string | undefined {
    if (!this.isDeduplicatedJobType(data.type)) {
      return undefined;
    }

    const payload = this.asRecord(data.payload);
    const stableKey =
      this.readString(payload, "bookingCode") ??
      this.readString(payload, "email") ??
      this.readString(payload, "bookingId") ??
      randomUUID();

    return `${data.type}:${stableKey}`;
  }

  private isDeduplicatedJobType(type: string): boolean {
    return [
      "send-register-email",
      "send-password-reset",
      "send-booking-confirmation",
      "finalize-ticket-delivery",
      "refund-failure-alert",
    ].includes(type);
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  }

  private readString(
    record: Record<string, unknown>,
    key: string
  ): string | undefined {
    const value = record[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }
}
