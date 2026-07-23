# 📝 WORK_LOG.md - Nhật ký dự án NestJS Ticket

| Ngày       | Agent    | Công việc thực hiện                                                   | Trạng thái     | Ghi chú                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| :--------- | :------- | :-------------------------------------------------------------------- | :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-05 | Leader   | Khởi tạo Phòng Lab ảo (.claude/lab)                                   | ✅ Done        | Thiết lập Architect, Senior, Security, DevOps, Junior Agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 2026-06-05 | Leader   | Thiết lập Cơ chế Chống quên & Work Log                                | ✅ Done        | Tạo WORK_LOG.md và cấu trúc Memory Persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 2026-06-05 | Leader   | Chuẩn hóa quy trình Plan & Delegation                                 | ✅ Done        | Quy định lưu Plan vào `docs/plan/` và cung cấp Prompt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-06-05 | Leader   | Bắt đầu Sprint P0 (Payment Integrity)                                 | ⏳ In Progress | Fix nhóm lỗi PAY-001 đến PAY-005 (Payment Integrity)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-06-05 | Senior   | **Sprint 1 — Multiple Time Slots per Event**                          | ✅ Done        | Thêm `TimeSlot` subdocument (label/startTime/endTime/capacity) vào `EventSchema`; `timeSlotId` vào `BookingSchema` và `TicketSchema` (sparse index); cập nhật DTOs (`TimeSlotDto`, `@ValidateNested`); `BookingService.createBooking` validate slot tồn tại; `TicketService` thêm `validateTimeSlotWindow()` (grace 30 phút), fail-safe orphan slot; 10 unit tests `ticket-timeslot.spec.ts`                                                                                                                                                                                                                                                                                   |
| 2026-06-05 | Security | **Sprint 2 — Self-Audit & Integrity Fixes**                           | ✅ Done        | Audit 5 hạng mục: integrity, concurrency, security, code quality, resilience. Fix: thêm sparse index `idx_timeslot_status` trên Booking và Ticket; đổi `if (slot)` sang fail-safe (`if (!slot) throw`) để chặn orphan slot bypass. Document risk: no per-slot capacity, no guard admin slot deletion                                                                                                                                                                                                                                                                                                                                                                           |
| 2026-06-05 | Senior   | **Sprint 3 — Refinement: Slot Capacity + Admin Guard + Type Cleanup** | ✅ Done        | (1) **Slot Capacity**: thêm `capacity?: number` vào `TimeSlot`, Redis `INCRBY` trước `withTransaction`, rollback `DECRBY` trong catch và sau cancel/expire; hằng số `SLOT_SOLD_KEY_PREFIX`, `SLOT_COUNTER_TTL_BUFFER_SEC`. (2) **Admin Safety Guard**: `updateEvent` phát hiện slot bị xóa, đếm booking active, throw 400 rõ ràng. (3) **Type Cleanup**: tạo `booking.types.ts` (`BookingCreatePayload`, `BookingCreateResult`, `SlotCapacityInfo`), thay toàn bộ `any` trong `booking.service.ts` bằng `FilterQuery<Booking>`, `Record<string, 1\|-1>`. (4) Unit tests `booking-slot-capacity.spec.ts` (6 tests). Fix build: cast `newBooking` cho `BookingCreateResult.data` |

## 2026-07-17 10:38 +07 - Phase 05 payment ops/refund workflow

- Implemented Payment Webhook Event Store:
  - Added `PaymentWebhookEvent` schema with unique provider/event id, status, retry count, timestamps, and sanitized payload storage.
  - Added `payment-ops` module with admin-only APIs:
    - `GET /payment-ops/webhook-events`
    - `GET /payment-ops/webhook-events/:id`
    - `POST /payment-ops/webhook-events/:id/retry`
  - Wired Stripe webhook handling to persist verified events, track `processing/succeeded/failed/ignored`, keep Redis/DB idempotency, and support manual retry.

- Implemented Refund Request workflow:
  - Added `RefundRequest` schema with active-request uniqueness per booking, reviewer metadata, provider refund id, and failure reason.
  - Added `refund` module with APIs:
    - `POST /refund-requests`
    - `GET /refund-requests/my`
    - `GET /refund-requests/my/:id`
    - `GET /refund-requests`
    - `GET /refund-requests/:id`
    - `POST /refund-requests/:id/approve`
    - `POST /refund-requests/:id/reject`
    - `POST /refund-requests/:id/retry`
  - Approval/retry uses state transitions `requested/failed -> processing -> succeeded/failed`, checks admin/organizer event ownership, and finalizes booking/ticket/zone inventory idempotently after provider success.

- Hardened existing payment refund path:
  - `PaymentService.issueAdminRefund()` now returns provider result instead of opaque `void`.
  - Stripe/PayPal refunds now persist provider refund id, refunded status, refunded time, and refund amount on `Payment`.
  - Refund failure path still restores booking payment status and queues refund failure alerts.

- Audit and contract updates:
  - Added audit actions for refund request/review/retry and webhook retry.
  - Kept public service/controller return types named and response DTOs mapped without exposing ODM documents.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec jest src/payment/payment.controller.spec.ts src/payment/payment.service.spec.ts src/booking/booking.service.spec.ts src/invoice/invoice.service.spec.ts --runInBand --silent --bail` passed: 4 suites, 220 passed, 3 skipped.
  - `pnpm exec jest --runInBand --silent --bail` passed: 91 suites passed, 2 skipped, 1673 tests passed, 25 skipped.
  - `pnpm exec eslint src/payment-ops src/refund src/payment/payment.controller.ts src/payment/payment.module.ts src/payment/payment.service.ts src/payment/application/use-case/issue-admin-refund.use-case.ts src/payment/types/payment.types.ts src/schemas/payment-webhook-event.schema.ts src/schemas/refund-request.schema.ts src/schemas/payment.schema.ts src/schemas/audit-log.schema.ts src/app.module.ts` passed.
  - `pnpm run build` passed. Note: current local Node is `v26.0.0`, while project engines require `>=18.0.0 <23.0.0`; rerun build/CI under Node 20/22 before deploy.

## 2026-07-17 10:45 +07 - Real API and docs smoke verification

- Rebuilt and restarted Docker app from current source with `docker compose up -d --build app`; Docker build used Node 22 image and `pnpm build` passed inside the image.
- Verified real infra readiness:
  - `GET http://127.0.0.1:9000/ready` returned `200`, MongoDB `up`, Redis `up`.
  - `GET http://127.0.0.1:9000/health` returned `200`.
- Verified browser/API docs surface:
  - `HEAD http://127.0.0.1:9000/swagger` returned `200` with `text/html`.
  - `GET http://127.0.0.1:9000/swagger-json` returned `200`.
  - Confirmed OpenAPI contains all 8 new Phase 05 routes for `payment-ops` and `refund-requests`.
- Verified authenticated real API smoke with admin seed login:
  - `POST /api/v1/auth/login` with admin seed returned `200` and set auth cookies.
  - `GET /api/v1/payment-ops/webhook-events?page=1&limit=5` returned `200` with envelope and paginated data.
  - `GET /api/v1/refund-requests?page=1&limit=5` returned `200` with envelope and paginated data.
  - `GET /api/v1/refund-requests/my?page=1&limit=5` returned `200` with envelope and paginated data.

## 2026-07-17 11:15 +07 - Full refund mutation verification

- Verified Stripe full refund mutation against real Stripe test API:
  - Created event/zone/booking through real API.
  - Created a real Stripe test `PaymentIntent` and posted a signed `checkout.session.completed` webhook to `/api/v1/payment/webhook`.
  - Created refund request through `POST /api/v1/refund-requests`.
  - Approved refund through `POST /api/v1/refund-requests/:id/approve`.
  - Stripe refund succeeded with provider refund id `re_3Tu34nJwBLm6t1fh0rHBtKdu`.
  - Verified Mongo state: booking `cancelled/refunded`, payment `refunded`, refund request `succeeded`, webhook event `succeeded`.

- Verified PayPal full refund mutation against real PayPal sandbox API:
  - Created event/zone/booking through real API.
  - Created a real PayPal sandbox card capture and linked it to the booking payment fixture.
  - Issued ticket through `POST /api/v1/ticket/from-booking`.
  - Created refund request through `POST /api/v1/refund-requests`.
  - Approved refund through `POST /api/v1/refund-requests/:id/approve`.
  - PayPal refund succeeded with provider refund id `7EY645314J830000E`.
  - Verified final state: booking `cancelled/refunded`, payment `refunded`, refund request `succeeded`, issued ticket `cancelled`.

- Fixed API docs completeness for browser/Swagger usage:
  - Added Swagger metadata for refund request/review DTOs.
  - Added Swagger metadata for payment webhook event query DTO.
  - Rebuilt Docker app and confirmed Swagger JSON exposes refund body fields `bookingCode`, `reason`, `amount`, review field `reason`, and payment-ops query params `provider`, `status`, `eventType`, `from`, `to`, `page`, `limit`.

- Final verification after docs patch:
  - `pnpm exec tsc --noEmit` passed.
  - Targeted payment/booking/invoice Jest passed: 4 suites, 220 passed, 3 skipped.
  - Full Jest passed: 91 suites passed, 2 skipped, 1673 tests passed, 25 skipped.
  - Touched-file ESLint passed.
  - Docker app rebuilt successfully with Node 22 image and `/ready` returned MongoDB `up`, Redis `up`.

## 2026-07-17 11:46 +07 - Phase 06 notification center

- Implemented Notification Center core:
  - Added `Notification` schema with user/channel/type/status, recipient email, metadata, sent/read/failure timestamps, and unique sparse idempotency key.
  - Added `notification` module with user APIs:
    - `GET /notifications`
    - `GET /notifications/unread-count`
    - `PATCH /notifications/:id/read`
    - `PATCH /notifications/read-all`
  - Added admin APIs:
    - `GET /admin/notifications`
    - `GET /admin/notifications/:id`
    - `POST /admin/notifications/:id/retry`

- Added queue-backed notification delivery:
  - Added jobs `send-notification-email`, `send-booking-expiry-reminder`, and `send-event-reminder`.
  - Worker updates notification status to `sent` or `failed`; admin retry uses deterministic BullMQ job id and avoids persisting raw verify/reset tokens in notification metadata.
  - Existing rich email templates are reused through `MailService`; generic notification email delivery was added for reminder-style notifications.

- Wired business events:
  - Register success, verification email, password reset, and booking confirmation events now create notification history.
  - Booking created/cancelled, payment succeeded, ticket issued, refund requested/rejected/succeeded/failed now create in-app notification records.
  - Booking expiry reminder scheduler scans pending unpaid bookings 5-10 minutes before expiry.
  - Event reminder scheduler enqueues 24h and 2h reminders for valid ticket holders with idempotency by event/user/window.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - Notification/queue/events targeted Jest passed: 3 suites, 48 tests.
  - Booking/payment/ticket targeted Jest passed: 5 suites, 295 passed, 3 skipped.
  - Reminder/payment integrity targeted Jest passed: 8 suites, 120 tests.
  - Full Jest passed: 92 suites passed, 2 skipped, 1683 tests passed, 25 skipped.
  - Touched-file ESLint passed.
  - `pnpm run build` passed; local warning remains that Node `v26.0.0` is outside project engine `>=18.0.0 <23.0.0`.
  - Docker app rebuilt successfully with Node 22 image via `docker compose up -d --build app`; `/ready` returned MongoDB `up`, Redis `up`.
  - Real API smoke passed:
    - unauthenticated `GET /api/v1/notifications/unread-count` returned `401` envelope.
    - admin seed login returned `200`.
    - authenticated `GET /api/v1/notifications?page=1&limit=5` returned `200`.
    - authenticated `GET /api/v1/notifications/unread-count` returned `200`.
    - authenticated `GET /api/v1/admin/notifications?page=1&limit=5` returned `200`.

## 2026-07-17 12:09 +07 - Phase 06 real API and browser docs recheck

- Rechecked Phase 06 against rebuilt Docker production artifact:
  - Added Swagger `notification` tag for the notification controller so browser docs group the new endpoints cleanly.
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/notification/notification.controller.ts` passed.
  - Docker image rebuilt successfully with Node 22; `docker compose up -d --no-deps app` started the rebuilt app because the existing `mongo-arbiter` service is unhealthy and blocks dependency waiting.
  - `GET http://127.0.0.1:9000/ready` returned MongoDB `up`, Redis `up`, and empty queue counters.
  - Admin seed login through `POST /api/v1/auth/login` returned `200`.
  - Authenticated `GET /api/v1/notifications/unread-count` returned `200` with `{ "unreadCount": 0 }`.
  - Authenticated `GET /api/v1/notifications?page=1&limit=5` returned `200` with paginated envelope.
  - Authenticated `GET /api/v1/admin/notifications?page=1&limit=5` returned `200` with paginated envelope.
  - Browser surface check: `HEAD /swagger` returned `200` `text/html`.
  - OpenAPI JSON contains all Phase 06 notification routes:
    - `/api/v1/notifications`
    - `/api/v1/notifications/unread-count`
    - `/api/v1/notifications/{id}/read`
    - `/api/v1/notifications/read-all`
    - `/api/v1/admin/notifications`
    - `/api/v1/admin/notifications/{id}`
    - `/api/v1/admin/notifications/{id}/retry`
  - OpenAPI JSON now includes the `notification` tag for these routes.

## 2026-07-17 12:18 +07 - Phase 06 mutation E2E and notification retry verification

- Ran a real mutation E2E flow against the rebuilt Docker production app from inside the app container:
  - `POST /api/v1/auth/register` created a new smoke user.
  - Register event created 3 real notification records:
    - `register_success` in-app notification.
    - `register_success` email notification.
    - `email_verification` email notification.
  - User login succeeded through `POST /api/v1/auth/login`.
  - `GET /api/v1/notifications?page=1&limit=10` returned the newly created notification records.
  - `PATCH /api/v1/notifications/:id/read` marked the real in-app notification as read.
  - `GET /api/v1/notifications/unread-count` returned `0`.

- Found and fixed a real queue bug during the mutation smoke:
  - Email notifications initially failed with BullMQ error `Custom Id cannot contain :`.
  - Root cause: notification email jobs, reminder jobs, DLQ jobs, and retry jobs used custom `jobId` values containing `:`.
  - Fixed notification email job IDs to use `send-notification-email-<notificationId>`.
  - Fixed booking expiry reminder and event reminder job IDs to avoid `:`.
  - Fixed queue dead-letter and retry job IDs to avoid `:`.
  - Added retry fallback for failed `register` email notifications when the original queue job is missing; sensitive token-based templates still do not rebuild raw tokens from stored notification metadata.

- Verified retry on the same real email notification record:
  - Forced the generated `register_success` email notification record to `failed` in local Docker DB for smoke verification.
  - Called `POST /api/v1/admin/notifications/:id/retry` on that same record.
  - Retry returned `200` with status `queued`.
  - Queue worker processed the retried email job.
  - `GET /api/v1/admin/notifications/:id` confirmed the same notification record ended at `sent` with `sentAt`.
  - Queue stats reported default queue `failed: 0` and dead-letter queue `failed: 0`.

- Verification after the fix:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint` on touched notification/queue files passed.
  - Notification/queue targeted Jest passed: 3 suites, 74 tests.
  - Event listener + booking/payment targeted Jest passed: 3 suites, 173 passed, 3 skipped.
  - Full Jest passed: 92 suites passed, 2 skipped, 1684 tests passed, 25 skipped.
  - Docker app image rebuilt successfully and `/ready` returned MongoDB `up`, Redis `up`.

## 2026-07-17 13:32 +07 - Phase 07 promotion and coupon implementation

- Implemented promotion/coupon support from `docs/backend-roadmap/07-promotion-coupon.md`:
  - Added `Promotion` and `PromotionUsage` schemas with indexes for code uniqueness, active windows, event/zone scope, booking usage, and per-user usage ordinal.
  - Added `PromotionModule`, controller, DTOs, presenter, service, and response types.
  - Added admin/organizer APIs for create/list/detail/update/disable promotions.
  - Added public/optional-auth validate/apply preview APIs; actual consumption happens inside booking creation.
  - Integrated `promotionCode` into `CreateBookingDto`.
  - Added booking fields: `originalTotalPrice`, `discountAmount`, `promotionCode`, and `promotionId`.
  - Booking creation now applies promotion inside the booking transaction, atomically increments `usedCount`, and creates `PromotionUsage`.
  - Pending/unpaid user cancel, admin cancel, and booking expiry now release promotion usage and decrement `usedCount`.
  - Payment checkout/PayPal creation now uses final discounted `booking.totalPrice` and carries promotion metadata.
  - Export ticket rows now include original booking total, discount, promotion code, and final booking total.
  - Revenue statistics continue to use final paid `Payment.amount`; no separate dashboard discount metric was added in this phase.

- Rule/production checks:
  - Promotion responses go through presenter/types; no ODM document is returned directly from the promotion API.
  - Promotion validation enforces active state, time window, event/zone scope, min order, max uses, and per-user limit.
  - Usage consumption is protected with transaction/session and an atomic `findOneAndUpdate` usage filter.
  - Checkout creation rejects zero/free totals for Stripe/PayPal instead of sending invalid provider amounts.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - Touched-file ESLint passed, including promotion, booking, payment, export, and the updated event guard spec.
  - Promotion/payment targeted Jest passed: 2 suites, 105 tests passed, 3 skipped.
  - Booking targeted Jest passed: 3 suites, 82 tests passed.
  - Payment sad-path/integrity targeted Jest passed: 3 suites, 60 tests passed.
  - Export/statistical targeted Jest passed: 5 suites, 98 tests passed.
  - Full Jest passed: 93 suites passed, 2 skipped, 1694 tests passed, 25 skipped.
  - `pnpm run build` passed; local warning remains that Node `v26.0.0` is outside project engine `>=18.0.0 <23.0.0`.
  - Docker image rebuilt with Node 22 and app restarted successfully.
  - `/ready` returned MongoDB `up` and Redis `up`.
  - Real API smoke passed against Docker app:
    - admin login succeeded.
    - active event/zone loaded through public APIs.
    - `POST /api/v1/promotions` created a real promotion.
    - `POST /api/v1/promotions/validate` returned a valid discount.
    - `POST /api/v1/booking` created a real booking with `originalTotalPrice=50000`, `discountAmount=10000`, and `totalPrice=40000`.
    - `POST /api/v1/payment/create-checkout-session` created a checkout session for the discounted booking.
    - `PATCH /api/v1/booking/cancel-booking` cancelled the pending booking.
    - `GET /api/v1/promotions/:id` confirmed `usedCount` returned to `0` after cancellation.
  - Swagger browser surface checked:
    - `HEAD /swagger` returned `200 text/html`.
    - OpenAPI JSON contains `/api/v1/promotions`, `/api/v1/promotions/{id}`, `/api/v1/promotions/{id}/disable`, `/api/v1/promotions/validate`, and `/api/v1/promotions/apply`.
    - OpenAPI `CreateBookingDto` contains `promotionCode`.

## 2026-07-17 13:57 +07 - Use-case refactor for payment-ops, notification, refund, and promotion

- Refactored the modules the review flagged as not matching the newer booking/area structure:
  - `PromotionService` is now a facade over:
    - `PromotionCommandService`
    - `PromotionQueryService`
    - `PromotionRedemptionService`
    - `PromotionPolicyService`
  - `PaymentOpsService` is now a facade over:
    - `PaymentWebhookRecorderService`
    - `PaymentWebhookStateService`
    - `PaymentWebhookQueryService`
    - `RetryWebhookEventUseCase`
    - `PaymentWebhookDispatcherService`
    - `PaymentWebhookEventRepository`
    - `PaymentWebhookEventPresenter`
  - `RefundService` is now a facade over:
    - `CreateRefundRequestUseCase`
    - `RefundQueryService`
    - `ReviewRefundRequestUseCase`
    - `RefundPolicyService`
    - `RefundRepository`
    - `RefundPresenter`
  - `NotificationService` is now a facade over:
    - `NotificationQueryService`
    - `NotificationReadService`
    - `NotificationWriterService`
    - `NotificationEmailService`
    - `NotificationEventService`
    - `NotificationReminderService`
    - `NotificationRepository`

- Cleanup against `rule.md`:
  - Reduced large module service responsibility while keeping controller/caller contracts stable.
  - Moved response mapping into presenters for newly split payment-ops/refund paths.
  - Moved persistence details behind repositories for payment-ops/refund/notification.
  - Moved promotion authorization/validation/business constraints into a policy service.
  - Kept external queue/mail/payment concerns behind intent-named services/use-cases.
  - Rechecked `unknown as`/empty catch patterns in the refactored modules; no new empty catch was introduced.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/promotion src/payment-ops src/refund src/notification` passed.
  - Targeted Jest passed: notification, queue processor, promotion, and payment controller suites: 4 suites, 92 tests.
  - Full Jest passed: 93 suites passed, 2 skipped, 1694 tests passed, 25 skipped.
  - `pnpm run build` passed; local warning remains that Node `v26.0.0` is outside project engine `>=18.0.0 <23.0.0`.
  - Docker image rebuilt with Node 22.
  - Docker app restarted successfully and became healthy.
  - `GET /ready` returned MongoDB `up`, Redis `up`, and queue counters at `0`.

## 2026-07-17 14:09 +07 - Real API/browser verification for promotion, notification, refund, and payment-ops

- Verified Docker runtime before real flows:
  - `docker compose ps app` showed the app container healthy on port `9000`.
  - `GET /ready` returned MongoDB `up`, Redis `up`, and queue counters at `0`.
  - The running app container uses the Docker MongoDB URI and Redis host `redis-cache`.

- Browser/API docs surface:
  - `HEAD /swagger` returned `200 text/html`.
  - Google Chrome was opened against `http://127.0.0.1:9000/swagger`.
  - Chrome tab scan confirmed `http://127.0.0.1:9000/swagger | Swagger UI`.
  - Swagger UI was also exercised through Chrome browser automation:
    - `POST /api/v1/auth/register` was expanded, filled, and executed from Swagger UI; response status `201`.
    - `POST /api/v1/auth/login` was expanded, filled, and executed from Swagger UI; response status `200`.
    - `GET /api/v1/auth/me` was executed from Swagger UI after login; response status `200`.
    - `GET /api/v1/notifications/unread-count` was executed from Swagger UI with the logged-in browser session; response status `200`, `unreadCount=1`.
    - Browser-flow user: `swagger_ui_1784273327501@example.com`.
  - OpenAPI JSON contains:
    - `/api/v1/promotions`
    - `/api/v1/promotions/validate`
    - `/api/v1/refund-requests`
    - `/api/v1/refund-requests/{id}/approve`
    - `/api/v1/payment-ops/webhook-events`
    - `/api/v1/admin/notifications/{id}/retry`

- Real promotion flow against Docker API passed:
  - Created promotion `PHASE0771680328`.
  - Created booking `BK20260717070120728BA6A3`.
  - Confirmed `originalTotal=50000`, `discountAmount=10000`, `finalTotal=40000`.
  - Created checkout session for the discounted booking.
  - Cancelled the pending booking and confirmed promotion usage was released.

- Real notification flow against Docker API and Docker MongoDB passed:
  - Registered user `phase06_1784272072029@example.com`.
  - Confirmed generated notification records through user notification API.
  - Marked in-app notification `6a59d4c8c906397e5688cee9` as read.
  - Confirmed unread count became `0`.
  - Forced email notification `6a59d4c8c906397e5688ceea` to `failed` in the Docker app database.
  - Retried the failed email through `POST /api/v1/admin/notifications/:id/retry`.
  - Confirmed final email status became `queued`.

- Real Stripe refund/payment-ops flow against Docker API passed:
  - Created event `6a59d4f9c906397e5688cf65`.
  - Created zone `6a59d4f9c906397e5688cf69`.
  - Created booking `BK2026071707084106D4B87E`.
  - Created Stripe sandbox PaymentIntent `pi_3Tu5szJwBLm6t1fh0F2hXNRU`.
  - Posted signed Stripe webhook and confirmed payment settlement.
  - Created refund request with initial status `requested`.
  - Approved refund and confirmed status `succeeded`.
  - Confirmed provider refund id `re_3Tu5szJwBLm6t1fh0NqpfWxu`.
  - Confirmed booking status became `cancelled` and payment status became `refunded`.
  - Confirmed payment-ops webhook event listing returned records for the flow.

- Full login -> booking -> payment -> mail/notification -> refund flow passed against Docker API and Stripe sandbox:
  - Logged in as verified user `user@example.com`.
  - Created event `6a59dd18c906397e5688d093`.
  - Created zone `6a59dd18c906397e5688d097`.
  - Created booking `BK2026071707432011651B40`.
  - Created Stripe sandbox PaymentIntent `pi_3Tu6QXJwBLm6t1fh0YVxQfdI`.
  - Posted signed Stripe webhook and confirmed payment settlement.
  - Verified payment notifications for the booking:
    - `booking_created` in-app status `sent`.
    - `payment_succeeded` in-app status `sent`.
    - `ticket_issued` in-app status `sent`.
    - booking confirmation email notification `6a59dd1bc906397e5688d0be` status `sent`, recipient `user@example.com`.
  - Created refund request `6a59dd20c906397e5688d0cd`.
  - Approved refund and confirmed provider refund id `re_3Tu6QXJwBLm6t1fh0wNLfGe8`.
  - Verified refund notifications:
    - `refund_requested` in-app status `sent`.
    - `refund_succeeded` in-app status `sent`.
  - Confirmed final booking status `cancelled` and payment status `refunded`.
  - Confirmed payment-ops webhook listing returned records for the flow.

## 2026-07-20 16:01 +07 - Phase 08.1 report module (sales/checkin/refund/reconciliation/organizer)

Implementing `docs/backend-roadmap/08-reporting-admin-operations.md`. Per user instruction, splitting Phase 8 into sub-sessions with checkpoints instead of doing 8.1+8.2+8.3 in one pass: **this entry covers 8.1 (Report Module) only.** 8.2 (dashboard cache/invalidation) and 8.3 (admin operations utilities/anomalies) are NOT started yet — pick up from there next.

- Implemented Report Module (`src/report/`) following the `statistical` module's lighter two-layer convention (service → repository + policy) rather than the payment-ops/refund use-case-heavy facade, since this module is fundamentally a bigger sibling of `statistical` (read-only, aggregation-heavy, multi-report):
  - `src/report/report.module.ts`, `report.controller.ts`, `report.service.ts` (thin facade over 5 application query services).
  - `src/report/application/{sales,checkin,refund,payment-reconciliation,organizer}-report-query.service.ts` — one per report type, each: resolve scope → resolve date range → call repository → assemble typed result.
  - `src/report/infrastructure/persistence/report.repository.ts` — all Mongo aggregations.
  - `src/report/domain/policies/report-scope.policy.ts` — resolves event/organizer authorization scope (admin unrestricted, organizer restricted via `eventIdIn`, explicit eventId/zoneId re-checked via `EventOwnershipService.assertCanManageEvent`).
  - `src/report/domain/report-range.util.ts` — `[from,to]` window resolution: defaults to a rolling 30-day window, rejects `from > to`, rejects ranges wider than 366 days (rule.md 6.5 backpressure). All comparisons run in UTC (`setUTCHours`, not local `setHours` — rule.md 7.4).
  - `src/report/domain/report-pagination.util.ts`, `report.constants.ts`, `domain/types/report.types.ts`, `dto/report-query.dto.ts`.
  - Added `EventOwnershipService.getManagedEventIdsForOrganizer(organizerId)` (pure lookup for an arbitrary target organizer, distinct from `getManagedEventIds(user)` which is caller-scoped) — used by `GET /reports/organizer/:organizerId`.
  - Routes (all under `@Roles("admin","organizer")` + `AuthGuard("jwt")` + `RolesGuard`): `GET /reports/sales`, `/reports/checkin`, `/reports/refunds`, `/reports/payment-reconciliation`, `/reports/organizer/:organizerId`.

- Key design decisions (spec was ambiguous on these — rule.md 7.1):
  - **Sales report source of truth is `Booking`, not `Payment`** (`totalPrice`/`totalRefunded` fields), not the `successStatuses` pattern statistical module uses on `Payment`. Reason: `Payment` can have multiple failed/duplicate rows per booking (would double-count), and `Booking.totalRefunded` is already the authoritative field the refund workflow keeps in sync — this guarantees `grossRevenue - refundAmount = netRevenue` always reconciles exactly (rule.md 1.5 derived-data invariant). Verified via integration test.
  - Sale population = bookings with `paidAt` in range AND `paymentStatus IN [paid, refund_pending, refunded]` (i.e. was ever successfully charged), so a booking that got refunded later still contributes its historical gross+refund figures to its original sale date instead of disappearing.
  - Check-in report population windows on Ticket `createdAt` (issuance), not `checkedInAt`, so the summary's denominator (`totalValidTickets`) and the check-in breakdowns share one consistent base population.
  - Refund report "approved" = `processing + succeeded + failed` counts (all three passed through an admin approval step out of `requested`); `rejected` is the other terminal from `requested`.
  - Payment reconciliation: 5 case-type detectors, each capped at `RECONCILIATION_CASE_TYPE_CAP=200` rows to bound aggregation cost; summary counts are the (possibly capped) detected-row counts, not separate `countDocuments` calls — documented limitation for pathological volumes beyond the cap. `payment_webhook_failed` case type is **only surfaced for an unrestricted admin scope** — `PaymentWebhookEvent` has no link to our internal Event id or Booking (its `eventId` field is the provider's webhook event id), so it cannot be attributed to a specific event/organizer.
  - Currency is hardcoded `"vnd"` in sales summary — system has no evidence of multi-currency booking mixing (rule.md 7.5 default).
  - Report list pagination uses the shared `PaginatedResponse<T>` (rule.md 9.5), not the newer payment-ops/refund bespoke `{items,total,page,limit}` shape.

- Rule/production checks:
  - No `any`/`unknown as`, no raw Mongo document returned from any public method — every aggregation row is typed and mapped.
  - Authorization re-checked per-resource: explicit `eventId`/`zoneId` always goes through `EventOwnershipService.assertCanManageEvent`, regardless of caller role (admin bypasses inside that call).
  - `zoneId` without `eventId` resolves the zone's owning event first, then authorizes; `zoneId`+`eventId` mismatch → 400.
  - `resolveOrganizerScope` requires `organizerId === caller.userId` unless caller is admin → 403 otherwise.
  - Empty `eventIdIn: []` (organizer manages nothing) correctly matches zero documents via Mongo `$in: []`, verified explicitly (does not fall back to "no filter").

- Tests added (33 new, all passing):
  - `report-range.util.spec.ts` — boundary: default window, from>to rejected, exactly-at/over `REPORT_MAX_RANGE_DAYS`, UTC normalization.
  - `report-scope.policy.spec.ts` — 12 cases: admin unrestricted, organizer restricted, explicit eventId ownership re-check (allow/deny), zoneId→event resolution, zoneId not found, zoneId/eventId mismatch, organizer-report self/other/admin access, invalid organizerId.
  - `report.repository.integration.spec.ts` — **real MongoDB** via `MongoMemoryServer` (single-node, no transactions needed for read aggregations): gross/net/refund arithmetic, date-range exclusion, cross-event scoping, empty-scope zero-match, revenue-by-event breakdown+pagination, check-in summary/rate, refund status counts, and all 3 scoped reconciliation detectors (booking-paid-without-ticket, payment-succeeded-booking-not-confirmed, duplicate-payment) plus the unrestricted-only webhook-failed detector.
  - `report-query-services.spec.ts` — facade wiring: correct repository call signatures/param order for all 5 application services, reconciliation's admin-unrestricted gating for webhook-failed.
  - A real UTC bug was caught and fixed during testing: `resolveReportDateRange`'s start/end-of-day padding originally used local-time `setHours` while inputs were parsed as UTC — fixed to `setUTCHours` (rule.md 7.4).
  - A real DI wiring bug was caught and fixed during Docker verification (not by tsc/jest): `ReportModule` provided `EventOwnershipService` but never registered the `Event` schema via `MongooseModule.forFeature`, so the app crash-looped on boot (`UnknownDependenciesException`). Fixed by adding `{ name: Event.name, schema: EventSchema }` to the module's Mongoose feature list.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/report src/event/event-ownership.service.ts src/app.module.ts` passed (after `--fix` for prettier formatting).
  - `pnpm exec jest src/report --silent`: 4 suites, 33 tests passed.
  - Full suite: `pnpm exec jest --runInBand --silent`: 97 suites passed, 2 skipped, 1727 passed, 25 skipped.
  - `pnpm run build` passed (Node engine warning only, same as prior phases).
  - Docker: `docker compose up -d --build --force-recreate --no-deps app` — first attempt crash-looped on the DI bug above; after the fix, `/ready` returned `200` with MongoDB `up`, Redis `up`.
  - Swagger JSON confirmed all 5 new routes registered under `/api/v1/reports/*`; `HEAD /swagger` returned `200 text/html`.
  - Real API smoke against Docker + real Mongo data (existing bookings/tickets/refunds from prior phases' smoke runs):
    - `GET /reports/sales` → `200`, `grossRevenue=608650000, refundAmount=250000, netRevenue=608400000` (arithmetic verified: gross-refund=net).
    - `GET /reports/checkin` → `200`, `totalValidTickets=788, checkedInTickets=5, checkInRate=0.63`.
    - `GET /reports/refunds` → `200`, `succeeded=5, totalRefundAmount=250000`, `refundAmountByEvent` breakdown populated.
    - `GET /reports/payment-reconciliation` → `200`, all-zero summary on healthy seeded data (no anomalies present, as expected).
    - `GET /reports/organizer/:id` → `200` for admin viewing any id and for an organizer viewing their own id; `403 FORBIDDEN` for an organizer viewing a different organizer's id.
    - Unauthenticated `GET /reports/sales` → `401`.
    - `GET /reports/sales?eventId=not-a-valid-id` → `400` with `"eventId must be a mongodb id"`.
  - Created two throwaway Docker-DB smoke accounts for this verification (`report8-admin@example.com`, `report8-organizer@example.com`), left in place consistent with prior phases' unremoved smoke accounts (local dev DB, not production).

## 2026-07-20 16:45 +07 - Phase 08.2 report cache and invalidation

Continuing Phase 8 in its own sub-session as planned. **This entry covers 8.2 (dashboard/report cache + invalidation) only.** 8.3 (admin operations utilities/anomalies) is NOT started yet.

- Implemented `src/report/infrastructure/cache/report-cache.service.ts` — cache-aside wrapper for all 5 report queries, wired into each `application/*-report-query.service.ts`'s `execute()` (authorization/scope resolution always runs first, unconditionally; only the resulting data query is cached).
  - **Invalidation strategy: single global generation counter** (`report:v1:gen`, one Redis `INCR`) instead of `SCAN`+`DEL` key-pattern invalidation. Every cache read embeds the current generation in its key; `invalidateAll()` bumps it, orphaning all previously-cached entries (never read again, expire via their own TTL). Chosen over precise per-event pattern matching because: (a) it's O(1) and cannot leak stale data past a mutation regardless of how the entry was scoped (explicit eventId, organizer's event list, or unrestricted admin), (b) rule.md 13.3 explicitly suggests "revision/version namespace" over ad-hoc pattern deletion, (c) report queries are not a per-request hot path, so a small amount of cross-organizer over-invalidation is an acceptable, simple, verifiably-correct tradeoff — documented in the file's class comment.
  - Cache key includes authorization scope explicitly (rule.md 13.1): `scopeKey()` renders `event-<id>` for an explicit eventId, `org-<sorted-ids>` for an organizer's managed-event list, or `all` for unrestricted admin — verified with a real-Redis test that two different scopes produce two distinct cache entries.
  - TTLs: sales=180s, refunds=120s, organizer=180s, reconciliation=60s (ops-alerting freshness), check-in=30s (most volatile — see below).
  - Read/write Redis failures are caught, logged, and always fall through to `compute()` — never a false failure (rule.md 3.5/13.3).

- Invalidation triggers wired into `NotificationEventService` (`src/notification/application/notification-event.service.ts`) rather than into Booking/Payment/Ticket business logic directly — chosen because `NotificationEventService` already sits at exactly the business events that change reportable numbers, so this is an additive best-effort side effect with zero changes to already-hardened booking/payment/ticket control flow (lowest blast radius). Wired for: `notifyBookingCreated`, `notifyBookingCancelled`, `notifyPaymentSucceeded`, `notifyTicketsIssued`, `notifyRefundReviewed` (both approved/succeeded and rejected branches), `notifyRefundFailed`.
  - `ReportModule` now exports `ReportCacheService`; `NotificationModule` imports `ReportModule` (no circular dependency — `ReportModule` only depends on Mongoose schemas + `EventOwnershipService`, not on any module that could depend back on `NotificationModule`).
  - **Documented gap, not silently skipped** (rule.md: remaining risk must be stated, not hidden): booking-expired, payment-failed, ticket-cancelled (post-issue), and ticket-check-in have no invalidation hook — booking-expired/payment-failed don't affect the sales report (only `paidAt`-having bookings count toward gross/net revenue in this design, so an expired/failed attempt was never counted). Ticket-cancel/check-in affect the check-in report specifically, which is why its TTL is the shortest (30s) — an explicit, bounded staleness tradeoff rather than an oversight.

- Rule/production checks:
  - Authorization is never skipped on a cache hit — `resolveEventScope`/`resolveOrganizerScope` always execute before the cache lookup in every application service, verified by a dedicated test that authorization runs even when the cache mock short-circuits computation entirely.
  - Cache invalidation failures never fail the API response (`invalidateAll()` never rejects — internal try/catch; `NotificationEventService.invalidateReportCacheSafely()` additionally wraps with `.catch()` + log as defense-in-depth).
  - JSON round-trip of cached values is safe because every report result type is already plain strings/numbers (dates pre-converted to ISO strings by the repository layer) — no ObjectId/Date/Map serialization risk.

- Tests added (16 new, all passing):
  - `report-cache.service.spec.ts` — 6 cases against a mocked Redis client: cache-miss computes+stores, cache-hit within TTL skips compute, distinct scopes produce distinct entries, `invalidateAll()` causes recomputation with a new generation, Redis read/write failures both fall through to `compute()` without throwing, `invalidateAll()` itself never throws on Redis failure.
  - `notification-event.service.spec.ts` (new file — none existed before) — 9 cases: each of the 6 wired methods calls `invalidateAll()` exactly once, a rejected invalidation doesn't fail the notification call, and an unrelated notification (`notifyRegisterSuccess`) does NOT trigger report cache invalidation.
  - `report-query-services.spec.ts` updated: all 5 application services now constructed with a `reportCache` pass-through mock (calls `compute()` immediately) so existing wiring assertions still exercise real repository call parameters; added a new case proving authorization still runs when the cache mock returns a value without calling `compute()`.
  - `notification.service.spec.ts` updated: `NotificationEventService` test construction now passes a mocked `reportCache`.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/report src/notification src/event` passed.
  - `pnpm exec jest src/report src/notification --silent`: 6 suites, 48 tests passed (report cache: 6, notification-event invalidation: 9, wiring: 6, plus pre-existing report suites).
  - Full suite: `pnpm exec jest --runInBand --silent`: 99 suites passed, 2 skipped, 1743 passed, 25 skipped.
  - `pnpm run build` passed.
  - Docker: `docker compose up -d --build --force-recreate --no-deps app` — booted clean on the first attempt this time (no repeat of 8.1's DI bug; `NotificationModule → ReportModule` wiring correct), `/ready` returned `200` with MongoDB `up`, Redis `up`.
  - Real cache verification against Docker + real Redis:
    - Two identical `GET /reports/sales?...` calls returned byte-identical `data` — confirmed cache-hit path serves the same computed result.
    - `redis-cli KEYS "report:v1:*"` showed the expected key shape `report:v1:sales:all:<from>:<to>:day:1:5:gen0`.
    - Manually bumping `report:v1:gen` via `INCR` (simulating what `invalidateAll()` does) caused the next identical request to create a **new** key `...gen1` while the old `...gen0` entry was left orphaned — confirmed the generation-based invalidation mechanism works against real Redis, not just mocks.
    - Did not additionally verify the automatic trigger (real booking creation → `notifyBookingCreated` → generation bump) through the full HTTP event/zone/booking flow, since that requires substantial fixture setup (event+zone+seat/price config) to prove a single already-unit-tested line of code (`invalidateReportCacheSafely` call inside `notifyBookingCreated`); the unit test suite proves this deterministically and the manual-INCR test proves the underlying mechanism against real Redis — judged as sufficient coverage without disproportionate additional session time. Flagging this as the one remaining un-verified-in-Docker path if a future session wants full E2E proof.

### Next up: 8.3 (admin operations utilities: system summary/anomalies, reissue tickets, resend confirmation, regenerate QR) — not started.

## 2026-07-20 17:35 +07 - Phase 08.3 admin operations utilities (final sub-session of Phase 8)

**This entry covers 8.3, the last piece of Phase 8.** After this entry, Phase 8 (`docs/backend-roadmap/08-reporting-admin-operations.md`) is fully implemented except one explicitly-skipped optional item (see below). The roadmap's own checklist has been updated in place.

- Implemented `src/admin-ops/` (new module) with 5 routes, all admin-only (`@Roles("admin")`, matching payment-ops/refund precedent — not organizer-accessible, since these are system-operations tools, not per-event organizer tools):
  - `GET /admin/system/summary` — pending bookings, pending-past-expiry count, tickets-missing-QR count, BullMQ queue health (reused `QueueService.getQueueStats()`), and a combined `anomalyCount`.
  - `GET /admin/system/anomalies` — merges and paginates the 4 anomaly types the roadmap lists.
  - `POST /admin/bookings/:bookingCode/reissue-tickets` — thin audit-wrapper over the **existing, already-idempotent** `TicketService.createTicketsFromBooking()` (no new ticket-issuance logic written; reused as-is).
  - `POST /admin/bookings/:bookingCode/resend-confirmation` — rebuilds `BookingConfirmationData` from the booking's `snapshot` + its issued tickets, then calls the existing `NotificationService.queueBookingConfirmationEmail()`.
  - `POST /admin/tickets/:ticketCode/regenerate-qr` — new capability, see below.

- **Anomaly detection reuses `ReportRepository.queryBookingPaidWithoutTicket()` from Phase 8.1** for the "booking paid without ticket" case (exported `ReportRepository` from `ReportModule` for this) rather than re-implementing the same aggregation — satisfies the roadmap's "không duplicate aggregation quá nhiều" intent across `/reports/payment-reconciliation` and `/admin/system/anomalies`. The other 3 anomaly types are new, implemented in `src/admin-ops/infrastructure/persistence/admin-ops.repository.ts`:
  - **Ticket missing QR**: `status IN [valid,used]` AND (`qrCode` absent or empty).
  - **Payment succeeded but email confirmation failed**: queries `Notification` directly for `{type: PAYMENT_SUCCEEDED, channel: EMAIL, status: FAILED}` — the notification record's type/channel/status already encodes this exact semantic (no join to `Payment` needed); `bookingCode` comes from the notification's own `metadata`.
  - **Seat lock expired but booking still pending too long**: `status=pending` AND `expiresAt` more than `BOOKING_PENDING_GRACE_MINUTES` (10 min) in the past — the grace period avoids false positives for bookings not yet swept by the next expiry-scheduler tick; verified both sides of the boundary in tests.
  - Anomaly detection intentionally looks at **all-time** data (not a caller-supplied date range like `/reports/*`) — an integrity problem from months ago is still a problem — via a dedicated `allTimeReportRange()` helper (epoch → now) passed into the reused report-repository method.
  - Each detector capped at `ANOMALY_TYPE_CAP=200` rows (same backpressure rationale as `RECONCILIATION_CASE_TYPE_CAP` in 8.1).

- **New ticket-module capability**: `TicketService.regenerateQrCode()` → `RegenerateTicketQrUseCase` (`src/ticket/application/use-case/`). Added to `TicketModule`/`TicketService`'s public surface rather than reaching into ticket internals from `admin-ops` (rule.md 19 module boundaries). Discovered during implementation that `UploadService.uploadQRCodeBuffer()` uses Cloudinary `overwrite:false`, so re-uploading at the same `ticketCode` public_id without first deleting the old asset would silently no-op (Cloudinary keeps the existing asset) — the use-case therefore explicitly calls `deleteQRCode()` before `generateQRCode()`; verified the call order with a test and confirmed the actual URL version-timestamp changed against real Cloudinary in Docker.
  - Blocks regeneration for `cancelled`/`expired` tickets (`BadRequestException`).
  - Invalidates ticket cache after update via the existing `TicketCacheService.invalidateTicketCache()`.

- New `AuditAction` members: `ADMIN_BOOKING_REISSUE_TICKETS`, `ADMIN_BOOKING_RESEND_CONFIRMATION`, `ADMIN_TICKET_REGENERATE_QR` — all 3 mutation endpoints call `AuditService.record()` after success (actor, reason, and action-specific metadata/bookingId/ticketId), verified for real against the Docker Mongo audit log.

- Module wiring: `AdminOpsModule` imports `ReportModule`, `TicketModule`, `NotificationModule`, `QueueModule`, `AuditModule` — no circular dependency (none of those import `AdminOpsModule`, and `ReportModule` itself only depends on Mongoose schemas + `EventOwnershipService`).

- Rule/production checks:
  - `resend-confirmation` explicitly refuses (400) a booking with no `snapshot` (legacy data) rather than silently sending a customer email with blank event/zone fields — a deliberate safety guard over adding live Event/Zone fallback-lookup complexity, documented as a known scope limit (very low practical risk since `snapshot` has been populated since early in the project).
  - No raw Mongo document returned from any admin-ops public method; all responses go through typed result interfaces.
  - Booking/ticket code lookups normalize to uppercase+trim before querying, consistent with existing ticket-module use-cases.

- Tests added (34 new, all passing):
  - `admin-ops.repository.integration.spec.ts` — **real MongoDB** via `MongoMemoryServer`: ticket-missing-QR detected/ignored-when-cancelled, payment-succeeded-email-failed detected (and NOT for sent/in-app notifications of the same type), pending-past-expiry detected/not-detected on both sides of the grace boundary, confirmed bookings never flagged, `loadBookingForResend` found/not-found.
  - `reissue-tickets.use-case.spec.ts`, `regenerate-ticket-qr.use-case.spec.ts` (admin-ops), `resend-confirmation.use-case.spec.ts` — success + every error path (not found, not confirmed, no snapshot) + audit-call assertions; errors correctly skip auditing.
  - `get-system-summary.use-case.spec.ts`, `get-anomalies.use-case.spec.ts` — aggregation correctness, merge/sort/paginate across all 4 anomaly types, minutes-past-expiry detail text.
  - `regenerate-ticket-qr.use-case.spec.ts` (ticket module) — delete-before-generate ordering, not-found, cancelled/expired rejection (without touching QR storage), blank-code rejection before any DB query.
  - Fixed a pre-existing shared test fixture: `src/ticket/testing/ticket-test.providers.ts` needed `RegenerateTicketQrUseCase` added after `TicketService`'s constructor grew a new dependency — without this, the entire existing `ticket.service.spec.ts` (77 tests) would have failed to compile its `TestingModule`.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/admin-ops src/ticket src/report src/notification src/event src/schemas/audit-log.schema.ts src/app.module.ts` passed.
  - `pnpm exec jest src/admin-ops src/ticket --silent`: 11 suites, 141 tests passed.
  - Full suite: `pnpm exec jest --runInBand --silent`: 106 suites passed, 2 skipped, 1769 passed, 25 skipped.
  - `pnpm run build` passed.
  - Docker: `docker compose up -d --build --force-recreate --no-deps app` — booted clean on the first attempt (all 5 admin routes mapped in the boot log), `/ready` returned `200`.
  - Real API smoke against Docker + real Mongo/Redis/Cloudinary/mail:
    - `GET /admin/system/summary` and `GET /admin/system/anomalies` → `200`, all-zero on healthy data (as expected).
    - `POST /admin/bookings/:bookingCode/resend-confirmation` on a real confirmed booking (`BK20260716061205945D40FA`) → `200 queued`; confirmed a real `payment_succeeded`/`email`/`sent` `Notification` document was created.
    - `POST /admin/bookings/:bookingCode/reissue-tickets` on the same booking (which already had 2 tickets) → `200`, returned the same 2 existing tickets unchanged — confirmed idempotency against real data, no duplicates created.
    - `POST /admin/tickets/:ticketCode/regenerate-qr` on a real ticket → `200`; confirmed against real Cloudinary that the returned `qrCode` URL's version timestamp changed (old `v1784182841` → new `v1784539955`) for the same `ticketCode` public_id, and `updatedAt` changed on the ticket document.
    - Confirmed all 3 mutations wrote the expected `AuditLog` documents (`admin.booking.resend_confirmation`, `admin.booking.reissue_tickets`, `admin.ticket.regenerate_qr`) with correct actor/reason/metadata.
    - Organizer role (`report8-organizer@example.com`) calling `GET /admin/system/summary` → `403 FORBIDDEN` (admin-only enforced).
    - `POST /admin/bookings/BK-NONEXISTENT/reissue-tickets` → `400 "Invalid booking code"`.

## Phase 8 summary (2026-07-20) — all 3 sub-phases complete

Phase 8 (`docs/backend-roadmap/08-reporting-admin-operations.md`) was implemented across 3 separate sub-sessions as planned (8.1 report module, 8.2 cache/invalidation, 8.3 admin operations), each independently verified with `tsc`/`eslint`/full Jest suite/`pnpm run build`/Docker rebuild/real API smoke before moving to the next. Total new/changed test count across the phase: **63 new tests**, full suite ended at **106 suites, 1769 passed, 25 skipped, 0 failed**. Only intentionally-skipped roadmap item: the optional report-snapshot precompute scheduler (cache-aside + short TTLs judged sufficient; see 8.2 entry for the invalidation-coverage tradeoffs that remain, notably ticket-cancel/check-in and booking-expiry having no direct cache-invalidation hook and relying on TTL alone).

## 2026-07-20 16:51 +07 - Phase 09.A test coverage gap-fill (refund + payment-ops modules)

Starting Phase 9 (`docs/backend-roadmap/09-test-load-test-runbook.md`) — test coverage, load tests, and runbooks, not new features. Per the "chia session" instruction, split into 4 sub-sessions: **A (this entry): fill the biggest correctness-test gaps. B: CI wiring for currently-skipped integration suites + notification idempotency + webhook-ordering test + `xdescribe` cleanup. C: load test scripts (9.4). D: 4 runbook docs (9.5-9.9) + final checklist.**

- Ran a dedicated audit (fork/subagent) mapping all 11 risk areas in roadmap 9.1 and every scenario in 9.3 against the ~106 existing Jest suites before writing anything, to avoid duplicating existing coverage. Key findings:
  - Most "concurrency" tests in this repo simulate concurrency via `Promise.allSettled` over a single service instance with **mocked** Mongoose models + mocked Redis — they prove the atomic-guard *logic* (correct filter/`$inc`/session usage), not a real DB/Redis race. Only 4 files use a real `MongoMemoryServer`/`MongoMemoryReplSet`.
  - `src/refund/` (user-facing refund request lifecycle: create/approve/reject/retry, the primary implementation of roadmap 9.3's "Refund" scenarios) had **zero test files**.
  - `src/payment-ops/` (admin webhook retry — roadmap risk area 9.1 #5's literal scenario) had **zero test files**.
  - 3 integration suites are gated behind env vars NOT set in CI (`RUN_PAYMENT_INTEGRATION`, `RUN_AREA_INTEGRATION`, `RUN_REDIS_SOCKET_INTEGRATION`) — they don't actually run in `.github/workflows/ci.yml` today. Deferred to Session B.
  - Notification idempotent-creation and Stripe event-ordering (`checkout.session.completed` vs `payment_intent.succeeded`) are unverified. Deferred to Session B.
  - A disabled `xdescribe` block exists at `payment.service.spec.ts:648`, likely superseded by `payment-sad-paths.spec.ts`. Deferred to Session B (needs a read-first decision, not just a blind delete).
  - Full audit detail (file:line references for what's already covered) is in the fork's report, not duplicated here — see this session's transcript if needed again.
  - **Decision**: real concurrent-load proof for booking/seat-lock/promotion (roadmap 9.3's "100 users book...", "100 users same seat...") is intentionally NOT re-simulated with more mocked unit tests here — the roadmap already separates this into 9.4 Load Test Scenarios, which is a strictly better tool for proving real concurrency (real HTTP, real connection pools, real Redis/Mongo as configured in docker-compose) than another `MongoMemoryReplSet` unit test would be. Session C covers this.

- Wrote tests for `src/refund/` (50 new tests across 5 new spec files):
  - `domain/policies/refund-policy.service.spec.ts` (22 tests) — every guard: ownership (request/view), refundability (create-time and review-time state matrices), `resolveRefundAmount` boundary cases (full/partial/zero/negative/exceeds-balance/already-fully-refunded), `assertCanReview` role+ownership matrix.
  - `application/create-refund-request.use-case.spec.ts` (6 tests) — happy path ordering (owner→refundable→amount→create), used-ticket-count metadata, ownership/refundability propagation, **E11000→409 Conflict mapping** (the active-request-per-booking unique index's error contract), non-duplicate-key errors re-thrown unchanged.
  - `application/review-refund-request.use-case.spec.ts` (11 tests) — the highest-risk file: `approve` happy path asserting the full sequence (moveToProcessing guard → booking flips to `refund_pending` → provider call → finalize booking/tickets/zone counters in a transaction → status `succeeded`), provider-failure path (status `failed`, booking explicitly asserted to NOT be cancelled/refunded, alert notification sent), status-guard rejections for `approve`/`reject`/`retry`, concurrent-status-change → 409 for both `moveToProcessing` and `reject`'s conditional update.
  - `application/refund-query.service.spec.ts` (7 tests) — `listMyRefundRequests` always self-scoped, admin unrestricted, organizer scoped to `getManagedEventIds`, **organizer-manages-nothing short-circuits to an empty result without querying** (doesn't fall back to unscoped — a real authorization-bypass risk if it had fallen through).
  - `__tests__/refund-request.concurrency.integration.spec.ts` (4 tests, **real `MongoMemoryServer`**) — proves `uniq_active_refund_request_per_booking` actually blocks 2 concurrent `create()` calls for the same booking (only 1 succeeds, other gets E11000), allows a new request once the prior reaches a terminal state, blocks while still `processing`, and doesn't cross-block different bookings.

- Wrote tests for `src/payment-ops/` (34 new tests across 6 new spec files):
  - `application/retry-webhook-event.use-case.spec.ts` (5 tests) — only `FAILED` events retryable, full happy-path sequence (`markRetrying`→dispatch→`markSucceeded`+`markWebhookSucceeded`+audit), `markIgnored` (not succeeded) for an unhandled event type, **`markFailed` + re-throw (not swallowed) when the dispatcher throws, with no audit record on failure**.
  - `application/payment-webhook-dispatcher.service.spec.ts` (10 tests, table-driven) — all 7 Stripe event types route to the correct `PaymentService` handler with the correct payload; unrecognized type returns `false` without calling any handler; non-Stripe provider and malformed payload (missing `data.object`) both rejected.
  - `application/payment-webhook-recorder.service.spec.ts` (6 tests) — first-delivery insert, lost-upsert-race-but-row-exists fallback, upsert-returns-null-and-nothing-exists hard failure (must not silently succeed), **real E11000 duplicate-key fallback to the existing row**, duplicate-key-but-row-still-missing re-throws, non-duplicate errors re-thrown unchanged.
  - `application/payment-webhook-state.service.spec.ts` (5 tests), `application/payment-webhook-query.service.spec.ts` (6 tests) — thin but previously-zero-coverage delegation/filter-building logic.
  - `__tests__/payment-webhook-event.concurrency.integration.spec.ts` (3 tests, **real `MongoMemoryServer`**) — directly proves roadmap 9.3's "Stripe webhook duplicated 10x" scenario: 10 concurrent `upsertReceivedStripeEvent()` calls for the same event id persist **exactly 1** row; a later duplicate delivery after the row was already marked `succeeded` does not overwrite it back to `received` (`$setOnInsert` semantics verified against a real unique index, not assumed); same `eventId` across different providers correctly kept as separate rows.

- Rule/production checks: no `any`/empty catch introduced; every mock explicit about return shape; fixed one bug caught by the tests themselves — `makeRequest()`/`reviewer.userId` test fixtures initially used non-ObjectId strings and dropped `overrides`, causing false failures that would have hidden real assertions (caught immediately by running the tests, not shipped).

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/refund src/payment-ops` passed (after `--fix` for prettier formatting).
  - `pnpm exec jest src/refund src/payment-ops --silent`: 11 suites, 84 tests passed.
  - Full suite: `pnpm exec jest --runInBand --silent`: **117 suites passed (was 106), 2 skipped, 1853 passed (was 1769), 25 skipped, 0 failed.**
  - `pnpm run build` passed.
  - No Docker rebuild/API smoke this session — zero production runtime files were changed, only `*.spec.ts` test files added, so there is no new runtime behavior to verify against a running instance.

### Next up: Session B — CI wiring for the 3 currently-skipped integration suites, notification idempotency test, Stripe webhook-ordering test, `xdescribe` decision at `payment.service.spec.ts:648`. Then C (load tests) and D (runbooks).

## 2026-07-21 10:46 +07 - Phase 09.B CI wiring + remaining correctness gaps

**This entry covers Session B.** Session C (load tests, roadmap 9.4) and Session D (4 runbook docs, roadmap 9.5-9.9) remain.

- **`xdescribe` at `payment.service.spec.ts:648` — deleted, not re-enabled.** Read the 3 disabled cases (`createCheckoutSession`: booking not found / status not PENDING / booking expired) and confirmed all 3 are already covered by real, currently-passing tests using the actual `PaymentService` (not the `any`-typed harness the xdescribe used): "booking not found" at `payment.service.spec.ts:1543` (`"PaymentService – createCheckoutSession extended"`), "status not PENDING" via `payment-sad-paths.spec.ts` C1-1/C1-2 (`Booking already paid` / `Booking is completed or cancelled` — a finer-grained split of the same guard), "booking expired" via `payment-sad-paths.spec.ts` B1 (line 450). Deleting dead/disabled test code here rather than leaving it as confusing vestigial signal (rule.md: no commented-out/dead code in production).

- **CI wiring — enabled all 3 previously-skipped integration suites in `.github/workflows/ci.yml`** (`RUN_PAYMENT_INTEGRATION`, `RUN_AREA_INTEGRATION`, `RUN_REDIS_SOCKET_INTEGRATION`, all `"true"` in the `test` job's `env:` block). These were gated behind env vars specifically to keep the default local `pnpm test` dev loop fast — CI is a different tradeoff (correctness before merge matters more than a few extra seconds), and per the audit these 3 suites are exactly the "real DB/Redis, not mocked" proof for payment fault-injection, area transaction rollback, and Socket.IO cross-instance propagation.
  - **Verified locally before touching CI**, since these hadn't run in a long time: spun up an ephemeral real `MongoMemoryReplSet` (matching what `RUN_AREA_INTEGRATION` and CI's own `mongodb-github-action` replica-set service provide) and a throwaway Redis container, then ran all 3 with their flags set.
  - **`area.integration.spec.ts`** and **`zone.gateway.spec.ts`** (Redis socket) both passed cleanly with no changes needed (11 and 8 tests respectively).
  - **`payment.integration.spec.ts` failed with a real bug**, not a flaky/environment issue: its `TestingModule` never provided `PaymentOpsService`, which `PaymentController`'s constructor has required since Phase 05 — this integration file predates that change and, because it's been `describe.skip`-gated in CI ever since, nobody noticed the fixture had silently drifted out of sync with the real controller. This is exactly the risk the roadmap-9 audit flagged about excluding suites from CI. Fixed by adding a `PaymentOpsService` mock provider to the test module (same shape as the working mock in `payment.controller.spec.ts`). Re-ran: all 8 tests pass.
  - Final combined verification: ran the **entire suite** with all 3 flags set simultaneously (simulating exactly what CI now does) — **119 suites passed, 1875 tests passed, 0 skipped, 0 failed.**

- **Notification idempotency** (roadmap 9.1 risk #10 — was unverified): read `NotificationWriterService.createNotification()` first per the audit's own recommendation before writing anything. Confirmed the mechanism: a sparse unique index on `metadata.idempotencyKey` (`uniq_notification_idempotency_key`), with the writer catching E11000 and returning the existing record instead of erroring — the same "create, catch duplicate, look up existing" pattern already proven for refund requests and payment webhook events in Session A.
  - `notification-writer.service.spec.ts` (8 tests, new file) — first-call creates, E11000 fallback returns existing record, E11000-but-no-idempotencyKey re-throws, E11000-but-record-not-found-by-key re-throws, non-duplicate errors re-thrown unchanged, userId/recipientEmail resolution and its NotFound/BadRequest error paths.
  - `notification-idempotency.integration.spec.ts` (3 tests, new file, **real `MongoMemoryServer`**) — 5 concurrent creates with the same `idempotencyKey` persist exactly 1 document (other 4 get real E11000), two different keys both succeed, and the index being **sparse** means notifications with no `idempotencyKey` at all aren't cross-blocked.

- **Stripe webhook ordering** (`checkout.session.completed` vs `payment_intent.succeeded`, roadmap 9.3 — was unverified): read `HandleStripeSideEventUseCase.handlePaymentIntentSucceeded` (previously zero test coverage for this whole file). Finding: it is a **deliberate no-op** (`logger.debug` only, no DB read/write, no queue interaction) — all real booking-confirmation/ticket-issuance logic lives exclusively in `handleCheckoutSessionCompleted`'s orchestrator. This is *why* delivery order doesn't matter: a true no-op commutes with anything. Added `handle-stripe-side-event.use-case.spec.ts` (5 tests) pinning this down explicitly (no Booking/Payment/queue interaction at all, safe whether simulated as arriving before or after booking confirmation, safe under triplicate delivery) — the point of the test is to fail loudly if a future change adds real logic to this handler without also reasoning about delivery ordering.

- Rule/production checks: no runtime/business-logic files changed in this session except the one genuine bug fix (`payment.integration.spec.ts`'s missing `PaymentOpsService` provider, a test-fixture-only change) and the CI workflow env additions; `xdescribe` removal double-checked for orphaned imports (none) via `tsc --noEmit` and `eslint` before/after.

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/notification src/payment` passed (after `--fix`; also removed one now-unused `NotificationStatus` import flagged by lint).
  - Full suite, default flags (mirrors local `pnpm test`): `pnpm exec jest --runInBand --silent`: **120 suites passed (was 117), 2 skipped, 1869 passed (was 1853), 22 skipped (was 25 — down by exactly the 3 deleted `xdescribe` cases), 0 failed.**
  - Full suite, all 3 integration flags enabled (mirrors CI exactly, run against an ephemeral real MongoDB replica set + throwaway Redis): **119 suites passed, 1875 passed, 0 skipped, 0 failed.**
  - `pnpm run build` passed.
  - No Docker rebuild/API smoke — the only production-facing change was a test-fixture fix inside an already-gated integration spec; no application runtime code changed.

### Next up: Session C — load test scripts (roadmap 9.4: 7 scenarios — 100 users booking a low-inventory zone, 100 users same seat, 500 users listing events, 50 concurrent checkout sessions, Stripe webhook duplicated 10x, 20 devices scanning the same ticket, dashboard queries during high booking/payment load). Then Session D — 4 runbook docs (9.5-9.9) + final Phase 9 checklist.

## 2026-07-21 11:06 +07 - Bug-fix pass on Phase 8/9 work (user-requested, before continuing Phase 9)

User asked to find and fix bugs to production-ready standard per rule.md before continuing. Did a fresh, skeptical re-read of the highest-risk code written across Phase 8/9 (not a re-confirmation of existing passing tests) and found two real bugs, one of them serious.

- **BLOCKER-adjacent bug, fixed: admin "resend confirmation" silently did nothing for any booking that already had a confirmation email queued** (i.e. almost every real booking — the automatic confirmation email is queued at payment time, and "resend" exists specifically for when that first attempt needs to be repeated). Root cause: `NotificationEventService.queueBookingConfirmationEmail()` uses a fixed `idempotencyKey` of `booking-confirmation-email:<bookingCode>`, and `ResendConfirmationUseCase` (8.3) called that same method. On the second call, the unique index on `metadata.idempotencyKey` collides (E11000); `NotificationWriterService.createNotification()`'s fallback returns the *existing* (already `sent`/`failed`) record instead of erroring; `NotificationEmailService.queueEmailNotification()` only enqueues an email job when the returned record's status is freshly `queued` — so the whole call chain returns `200 { status: "queued" }` while **never actually enqueueing anything**. My own Phase 8.3 Docker smoke test didn't catch this because that particular test booking happened to have no prior confirmation email queued, so the very first call never hit the collision path.
  - Fix: added a new `NotificationEventService.resendBookingConfirmationEmail()` (exposed via `NotificationService`), deliberately a separate method rather than a parameter on the existing one — it builds a per-call-unique `idempotencyKey` (`booking-confirmation-email:resend:<bookingCode>:<timestamp>:<4-byte-random-hex>`, the random suffix because two admin clicks in the same millisecond are possible) so a resend can never collide with the original send *or* with a previous resend, and always actually enqueues. `ResendConfirmationUseCase` now calls this new method instead. The original `queueBookingConfirmationEmail()` and its dedup behavior for the automatic single-send/duplicate-webhook-protection path are untouched — zero risk to that already-verified flow.
  - **Verified for real, not just in tests**: rebuilt Docker, called `resend-confirmation` a second time on a real booking that already had a `sent` confirmation-email notification from an earlier session (`BK20260716061205945D40FA`). Before the fix this would have been a silent no-op (confirmed by re-deriving what the old code path would have returned); after the fix, confirmed via direct Mongo inspection that a **second, genuinely new** notification document was created (`status: queued` → `sent` after the queue worker ran, distinct `idempotencyKey`, distinct `_id`), i.e. a real email was actually sent.
  - Tests: `resend-confirmation.use-case.spec.ts` updated to assert `resendBookingConfirmationEmail` (not `queueBookingConfirmationEmail`) is called; `notification-event.service.spec.ts` gained 2 new tests directly proving the two methods (and two resend calls back-to-back) never produce the same idempotencyKey.

- **Cache-consistency gap, fixed: reassigning an event's organizer didn't invalidate the report cache.** `/reports/*` and `/admin/system/*` cache results scoped by an organizer's `eventIdIn` (their currently-managed event list, see Phase 8.2). `EventMemberService.addOrganizerToEvent()`/`removeOrganizerFromEvent()` never triggered `ReportCacheService.invalidateAll()`, so a just-added or just-removed organizer's cached report numbers could reflect the *old* managed-event list for up to the cache's TTL (~180s) even though authorization itself was correctly re-checked on every call. Fixed by wiring `invalidateReportCacheSafely()` (same best-effort, never-throws pattern as the existing `NotificationEventService` invalidation hooks) into both methods; `EventModule` now imports `ReportModule` (verified no circular dependency — `ReportModule` only depends on Mongoose schemas + `EventOwnershipService`, not on `EventModule` or anything that imports it).
  - Tests: new `event-member.service.spec.ts` (4 tests) — invalidates on successful add, invalidates on successful remove, does NOT invalidate when remove fails validation, membership change still succeeds even if cache invalidation itself rejects.
  - Fixed 2 pre-existing test fixtures that broke because `EventMemberService`'s constructor grew a new required dependency (`ReportCacheService`): `event.service.spec.ts` and `event.guard.spec.ts` both construct it as a real provider via `Test.createTestingModule` — added a mock provider to each (same class of fixture-drift bug as the `payment.integration.spec.ts` one found in Session B, caught immediately this time by `tsc`/running the tests rather than by an unrelated integration flag).
  - **Verified for real**: rebuilt Docker, called the real add-organizer and remove-organizer endpoints against a live event, confirmed `report:v1:gen` in Redis incremented on both calls (10 → 11 → 12), and confirmed the event's organizer list was left in its original state afterward.

- Also fixed one narrower issue while re-reading `RegenerateTicketQrUseCase` (8.3, ticket module): the final `findOneAndUpdate` didn't re-guard the ticket's `status` — only the initial `findOne` checked it wasn't `cancelled`/`expired`. Between that check and the write (which does 2 real network calls to Cloudinary first), a concurrent cancellation could still let a QR get regenerated for a ticket that's no longer valid (check-then-act, rule.md 2.2). Low real-world impact (regenerating a QR image doesn't itself let anyone check in with a cancelled ticket) but cheap and correct to close: added `status: { $nin: ["cancelled", "expired"] }` to the update filter, and changed the not-updated branch to `ConflictException` (409, matching rule.md's status-code semantics for a state race) instead of reusing `NotFoundException`. Updated `regenerate-ticket-qr.use-case.spec.ts` (ticket module) with a new race-guard test and the updated filter assertion.

- Ran `mcp__ide__getDiagnostics` across the whole workspace first — no diagnostics on any authored file (only pre-existing, unrelated `tsconfig.json` deprecation warnings about `moduleResolution`/`baseUrl`, not something introduced this session and out of scope).

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec eslint src/event src/notification src/admin-ops src/ticket` passed (after `--fix`).
  - Full suite: `pnpm exec jest --runInBand --silent`: **121 suites passed (was 120), 2 skipped, 1876 passed (was 1869), 22 skipped, 0 failed.**
  - `pnpm run build` passed.
  - Docker rebuilt (`--force-recreate`) — booted clean, `/ready` returned MongoDB `up` / Redis `up`.
  - Real API smoke against Docker + real Mongo/Redis/Cloudinary/mail (both fixes, see above for detail): resend-confirmation on an already-confirmed booking now creates and actually delivers a new email; add/remove-organizer now visibly bumps the report cache generation counter in Redis.

### Next up: still Session C (load test scripts, roadmap 9.4) and Session D (4 runbook docs, roadmap 9.5-9.9) — unchanged from before this bug-fix detour.

## 2026-07-22 16:20 +07 - Close final production-readiness gap: event-cancellation API contract change (item 17)

Verification pass (production-readiness-audit-2026-07-22.md re-audit) had left one item open: `POST /event/:id/cancel`'s response shape changed from synchronous (`EventCancelResult`) to async (`EventCancellationJobDetail`, NEW#6) with no breaking-change documentation and no confirmed frontend impact assessment (rule.md §9.4). Closing it for real, not just noting it as a risk.

- **Frontend impact — verified, not assumed.** Read `admin-frontend`'s `src/services/event/index.ts` in full: `eventService`'s only methods are `getAllEvents`, `getDeletedEvents`, `getEventById`, `getEventZones`, `createEvent`, `updateEvent`, `deleteEvent`, `restoreEvent` — no `cancelEvent` method exists. Grepped `admin-frontend/src` for `cancel-status`, `cancelJobId`, `EventCancellationJobDetail`, `cancelStatus`, `cancelEvent`, and checked `EventDetail.tsx`/`EventList.tsx` for any cancel action UI — zero matches anywhere. `git log --all --oneline --grep="cancel" -i` in that repo returns no commits. **Conclusion: event cancellation was never wired up in admin-frontend, old or new contract — zero callers, zero regression risk.** No frontend code changed (there was nothing to change).
- **Documented the contract properly**, since "verified no one's using it yet" doesn't excuse leaving a breaking API change undocumented for whoever builds this UI feature next. Added `docs/API_CHANGELOG.md` — old `EventCancelResult` shape (full detail from the pre-refactor `git show HEAD:src/event/application/event-lifecycle.service.ts`), new `EventCancellationJobDetail` shape, the async flow (`POST cancel` → job created → `GET cancel-status` polling), the callers-affected evidence above, and the migration decision (straight replacement, no version bump/compat layer, justified by zero existing callers — re-open this entry if a caller is ever found on the old shape). Added a short doc-comment on `EventLifecycleController.cancelEvent` pointing at the changelog so a future reader finds it without already knowing it exists.
- **Contract tests — the actual gap, not just the doc.** `event.controller.spec.ts` had a stale mock at the `cancelEvent` delegation test still shaped like the old `{ event, cancelled, failed }` result (cast `as any`, so it silently stopped meaning anything after the NEW#6 refactor). Fixed that mock and added a dedicated test asserting the controller returns the real `EventCancellationJobDetail` shape and explicitly does NOT return the old fields. Also added `event-cancellation.presenter.spec.ts` (new file, 6 tests) — none existed before for this presenter despite it being the actual API-contract boundary: exact field-set lock, old-shape-absence check, ObjectId→string stringification (rule.md §9.2 — no ODM leaks), date-field ISO serialization (present vs. omitted), per-booking `failures` array shape, and every `EventCancellationJobStatus` value round-tripping unchanged.
- Deliberately did not touch response behavior (e.g. considered whether `200` should be `202 Accepted` for an async-accepted response, but that's a separate, unrequested contract change — left as-is).

- Verification:
  - `pnpm exec tsc --noEmit` passed.
  - `pnpm exec jest src/event --silent`: **10 suites passed, 179 passed, 0 failed** (up from 9 suites/173 tests — new presenter spec + new controller contract test).
  - No application runtime behavior changed — only test fixtures, a doc comment, and new documentation/test files.

Item 17 is now genuinely closed: frontend-impact verified with evidence (not assumed), contract documented, and the exact response shape is pinned by tests that would fail on a silent regression.

## 2026-07-22 +07 - Close final live-runtime proof gap: Docker smoke test (item 18)

User-ran the missing end-to-end Docker smoke against the rebuilt backend image and shared the full result. This closes the last production-readiness item that had previously only been verified by config/code review.

- **Build proof:** `docker compose build app` rebuilt the application image cleanly, replacing the previous image that was 28h stale.
- **Boot proof:** `docker compose up -d` started the full stack (`app`, `mongo1`, `mongo2`, `mongo3`, `redis-cache`, `redis-queue`). The app container reached `healthy` through its own Docker healthcheck, proving the healthcheck path works in a live container.
- **Readiness proof:** browser check of `GET /ready` returned `{"status":"ready","dependencies":{"mongodb":"up","redis":"up"},"queue":{...}}`, confirming live MongoDB + Redis dependency checks.
- **Swagger/route proof:** browser check of `GET /swagger` loaded successfully and showed both live event-cancellation routes registered: `POST /event/{id}/cancel` and `GET /event/{id}/cancel-status`, matching `docs/API_CHANGELOG.md`.
- **Metrics proof:** authenticated/headered `GET /metrics` returned real BullMQ queue depth data, including `queue_depth{queue="default",state="completed"} 41`, with all other states/queues populated from live counts. `notification_failures_total` was also registered. This is the live proof for the `queue_depth` observability fix, not just unit/config coverage.
- **Data path proof:** `GET /api/v1/event?page=1&limit=5` returned real persisted MongoDB data (`142` events) with the expected response envelope and pagination, confirming the HTTP -> service -> MongoDB -> response path.
- **Cleanup proof:** the temporary `.env` metrics-secret change used only for checking `/metrics` was reverted, and all containers were stopped afterward, returning the workspace to its pre-smoke runtime state.

Item 18 is now genuinely closed: Docker image build, full-stack boot, container healthcheck, `/ready`, Swagger route registration, Prometheus metrics, and a real persisted-data API round trip have all been verified live.
