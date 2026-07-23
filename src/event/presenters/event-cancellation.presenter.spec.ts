import { Types } from "mongoose";
import { EventCancellationJobStatus } from "@src/schemas/event-cancellation-job.schema";
import { EventCancellationPresenter } from "./event-cancellation.presenter";
import type { EventCancellationJobSource } from "../domain/types/event-cancellation.types";

/**
 * Locks the POST /event/:id/cancel and GET /event/:id/cancel-status API
 * contract (docs/API_CHANGELOG.md — "Event cancellation is now async").
 * This is the exact boundary a frontend consumer types against, so a field
 * being renamed/dropped/re-typed here is a silent breaking change per
 * rule.md 9.4 unless caught by a test at this presenter.
 */
describe("EventCancellationPresenter — API contract", () => {
  const presenter = new EventCancellationPresenter();

  const makeJob = (
    overrides: Partial<EventCancellationJobSource> = {}
  ): EventCancellationJobSource => ({
    _id: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    initiatedBy: new Types.ObjectId(),
    reason: "Weather emergency",
    status: EventCancellationJobStatus.PENDING,
    totalBookings: 2137,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    skippedCount: 0,
    failures: [],
    ...overrides,
  });

  it("returns exactly the EventCancellationJobDetail contract fields — no more, no less", () => {
    const job = makeJob();

    const detail = presenter.toDetail(job);

    expect(Object.keys(detail).sort()).toEqual(
      [
        "id",
        "eventId",
        "initiatedBy",
        "reason",
        "status",
        "totalBookings",
        "processedCount",
        "succeededCount",
        "failedCount",
        "skippedCount",
        "failures",
      ].sort()
    );
  });

  it("does NOT return the deprecated synchronous EventCancelResult fields (event/cancelled/failed)", () => {
    const detail = presenter.toDetail(makeJob());

    expect(detail).not.toHaveProperty("event");
    expect(detail).not.toHaveProperty("cancelled");
    expect(detail).not.toHaveProperty("failed");
  });

  it("stringifies ObjectId fields — no ODM document/ObjectId leaks to the API boundary (rule.md 9.2)", () => {
    const job = makeJob();

    const detail = presenter.toDetail(job);

    expect(typeof detail.id).toBe("string");
    expect(typeof detail.eventId).toBe("string");
    expect(typeof detail.initiatedBy).toBe("string");
    expect(detail.id).toBe(job._id.toString());
    expect(detail.eventId).toBe(job.eventId.toString());
    expect(detail.initiatedBy).toBe(job.initiatedBy.toString());
  });

  it("serializes date fields to ISO strings only when present, and omits them entirely when absent", () => {
    const withoutDates = presenter.toDetail(makeJob());
    expect(withoutDates.startedAt).toBeUndefined();
    expect(withoutDates.completedAt).toBeUndefined();
    expect(withoutDates.createdAt).toBeUndefined();
    expect(withoutDates.updatedAt).toBeUndefined();
    expect(withoutDates).not.toHaveProperty("startedAt");
    expect(withoutDates).not.toHaveProperty("completedAt");

    const startedAt = new Date("2026-07-22T00:00:00.000Z");
    const completedAt = new Date("2026-07-22T00:05:00.000Z");
    const withDates = presenter.toDetail(
      makeJob({
        startedAt,
        completedAt,
        createdAt: startedAt,
        updatedAt: completedAt,
      })
    );
    expect(withDates.startedAt).toBe(startedAt.toISOString());
    expect(withDates.completedAt).toBe(completedAt.toISOString());
    expect(withDates.createdAt).toBe(startedAt.toISOString());
    expect(withDates.updatedAt).toBe(completedAt.toISOString());
  });

  it("maps per-booking failures with only bookingId/error/failedAt, all as plain strings", () => {
    const bookingId = new Types.ObjectId();
    const failedAt = new Date("2026-07-22T00:01:00.000Z");
    const job = makeJob({
      failures: [{ bookingId, error: "Stripe timeout", failedAt }],
    });

    const detail = presenter.toDetail(job);

    expect(detail.failures).toEqual([
      {
        bookingId: bookingId.toString(),
        error: "Stripe timeout",
        failedAt: failedAt.toISOString(),
      },
    ]);
  });

  it("passes through every EventCancellationJobStatus value unchanged (state machine contract)", () => {
    for (const status of Object.values(EventCancellationJobStatus)) {
      const detail = presenter.toDetail(makeJob({ status }));
      expect(detail.status).toBe(status);
    }
  });
});
