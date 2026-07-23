import { ResolvedReportRange } from "@src/report/domain/report-range.util";

/**
 * Admin anomaly detection intentionally looks at ALL unresolved issues
 * regardless of age (an integrity problem from months ago is still a
 * problem), unlike the `/reports/*` endpoints which bound their
 * aggregation cost to a caller-supplied date window. Reused report
 * repository methods that take a `ResolvedReportRange` are given this
 * wide-open range instead.
 */
export function allTimeReportRange(): ResolvedReportRange {
  const epoch = new Date(0);
  const now = new Date();
  return {
    fromDate: epoch,
    toDate: now,
    fromIso: epoch.toISOString(),
    toIso: now.toISOString(),
  };
}
