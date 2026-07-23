import { BadRequestException } from "@nestjs/common";
import {
  REPORT_DEFAULT_RANGE_DAYS,
  REPORT_MAX_RANGE_DAYS,
} from "@src/report/report.constants";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface ResolvedReportRange {
  fromDate: Date;
  toDate: Date;
  fromIso: string;
  toIso: string;
}

/**
 * Every report query is windowed by [from, to] to bound aggregation cost
 * (rule.md 6.5 backpressure). Missing bounds default to a rolling
 * REPORT_DEFAULT_RANGE_DAYS window ending "now"; an explicit range wider
 * than REPORT_MAX_RANGE_DAYS is rejected rather than silently truncated.
 *
 * The max-range check runs on the raw (unpadded) input instants so a
 * caller-supplied `from`/`to` exactly REPORT_MAX_RANGE_DAYS apart always
 * passes regardless of end-of-day padding applied afterward for the query.
 */
export function resolveReportDateRange(
  from?: string,
  to?: string
): ResolvedReportRange {
  const now = new Date();
  const rawTo = to ? new Date(to) : now;
  const rawFrom = from
    ? new Date(from)
    : new Date(rawTo.getTime() - REPORT_DEFAULT_RANGE_DAYS * MS_PER_DAY);

  if (rawFrom.getTime() > rawTo.getTime()) {
    throw new BadRequestException("`from` must not be after `to`");
  }

  const rangeDays = (rawTo.getTime() - rawFrom.getTime()) / MS_PER_DAY;
  if (rangeDays > REPORT_MAX_RANGE_DAYS) {
    throw new BadRequestException(
      `Date range too large — max ${REPORT_MAX_RANGE_DAYS} days`
    );
  }

  const fromDate = from ? startOfDay(rawFrom) : rawFrom;
  const toDate = to ? endOfDay(rawTo) : rawTo;

  return {
    fromDate,
    toDate,
    fromIso: fromDate.toISOString(),
    toIso: toDate.toISOString(),
  };
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setUTCHours(23, 59, 59, 999);
  return copy;
}
