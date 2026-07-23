import { BadRequestException } from "@nestjs/common";
import { resolveReportDateRange } from "./report-range.util";
import {
  REPORT_DEFAULT_RANGE_DAYS,
  REPORT_MAX_RANGE_DAYS,
} from "@src/report/report.constants";

describe("resolveReportDateRange", () => {
  it("defaults to a rolling window ending now when from/to are omitted", () => {
    const before = Date.now();
    const range = resolveReportDateRange();
    const after = Date.now();

    expect(range.toDate.getTime()).toBeGreaterThanOrEqual(before);
    expect(range.toDate.getTime()).toBeLessThanOrEqual(after);

    const expectedFrom =
      range.toDate.getTime() - REPORT_DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000;
    expect(range.fromDate.getTime()).toBe(expectedFrom);
  });

  it("normalizes explicit from/to to start-of-day/end-of-day in UTC", () => {
    const range = resolveReportDateRange("2026-01-01", "2026-01-31");

    expect(range.fromDate.getUTCHours()).toBe(0);
    expect(range.fromDate.getUTCMinutes()).toBe(0);
    expect(range.toDate.getUTCHours()).toBe(23);
    expect(range.toDate.getUTCMinutes()).toBe(59);
  });

  it("rejects from after to", () => {
    expect(() => resolveReportDateRange("2026-02-01", "2026-01-01")).toThrow(
      BadRequestException
    );
  });

  it("rejects a range wider than REPORT_MAX_RANGE_DAYS", () => {
    const from = "2020-01-01";
    const toDate = new Date(from);
    toDate.setDate(toDate.getDate() + REPORT_MAX_RANGE_DAYS + 5);
    const to = toDate.toISOString().slice(0, 10);

    expect(() => resolveReportDateRange(from, to)).toThrow(BadRequestException);
  });

  it("accepts a range exactly at REPORT_MAX_RANGE_DAYS", () => {
    const from = "2020-01-01";
    const toDate = new Date(from);
    toDate.setDate(toDate.getDate() + REPORT_MAX_RANGE_DAYS);
    const to = toDate.toISOString().slice(0, 10);

    expect(() => resolveReportDateRange(from, to)).not.toThrow();
  });
});
