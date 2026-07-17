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
