export const DEFAULT_QUEUE_NAME = "default";
export const DEAD_LETTER_QUEUE_NAME = "dead-letter";

/**
 * Dedicated queue for `cancel-event-bookings` (HIGH — event cancellation
 * queue starvation). This job walks every booking of a large event
 * sequentially and can occupy a worker for tens of minutes; it MUST NOT
 * share a worker lane with latency-sensitive jobs (refund-failure-alert,
 * booking confirmation/ticket delivery, notifications) on the `default`
 * queue, or those jobs queue up behind it for as long as the cancellation
 * runs. A `@Processor` per queue name gets its own independent BullMQ
 * Worker, so isolating the job type onto its own queue is what actually
 * prevents the starvation — see EventCancellationQueueProcessor.
 */
export const EVENT_CANCELLATION_QUEUE_NAME = "event-cancellation";

/** Job `type` discriminator routed to EVENT_CANCELLATION_QUEUE_NAME — shared
 * between the enqueue side (EventLifecycleService) and the routing/handling
 * side (QueueService, EventCancellationQueueProcessor) so they can never
 * drift out of sync (a mismatch here would silently misroute the job back
 * onto `default`, reintroducing the exact starvation this constant exists
 * to prevent). */
export const EVENT_CANCELLATION_JOB_TYPE = "cancel-event-bookings";
