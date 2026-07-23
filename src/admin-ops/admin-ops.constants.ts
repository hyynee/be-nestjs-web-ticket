/** How long past `expiresAt` a `pending` booking must sit before the
 * expiry scheduler having missed it counts as an anomaly, rather than a
 * booking that simply hasn't been swept yet by the next scheduler tick. */
export const BOOKING_PENDING_GRACE_MINUTES = 10;

/** Caps each anomaly detector's row fetch so an unhealthy system can't
 * force an unbounded aggregation (rule.md 6.5 backpressure) — mirrors
 * RECONCILIATION_CASE_TYPE_CAP in the report module. */
export const ANOMALY_TYPE_CAP = 200;

export const ADMIN_OPS_DEFAULT_PAGE = 1;
export const ADMIN_OPS_DEFAULT_LIMIT = 20;
export const ADMIN_OPS_MAX_LIMIT = 100;
