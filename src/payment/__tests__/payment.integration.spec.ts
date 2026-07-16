/**
 * Payment Integration Tests — Failure Injection (P0 Sprint)
 *
 * Dùng MongoDB replica set thật qua MONGODB_URI/PAYMENT_INTEGRATION_MONGODB_URI
 * (hỗ trợ transactions) + supertest (HTTP thật).
 * Redis được mock; jest.spyOn() tiêm lỗi tại đúng thời điểm quan trọng.
 *
 *   PAY-001: Redis DOWN → MongoDB fallback idempotency (không retry storm)
 *   PAY-003: PayPal capture thành công + DB write thất bại → PendingConfirmation tồn tại
 *   PAY-005: Partial refund không bị thoát sớm → refundHistory được cập nhật
 */

// Env vars phải đặt TRƯỚC khi PaymentService constructor chạy (đọc config trực tiếp)
process.env.STRIPE_SECRET_KEY = "sk_test_51IntegrationFakeKeyForTests000000000";
process.env.STRIPE_WEBHOOK_SECRET =
  "whsec_integration_test_secret_00000000000000000000000";
process.env.PAYPAL_CLIENT_ID = "fake_paypal_client_integration";
process.env.PAYPAL_CLIENT_SECRET = "fake_paypal_secret_integration";

import { ExecutionContext, INestApplication } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongooseModule } from "@nestjs/mongoose";
import { AuthGuard } from "@nestjs/passport";
import { ThrottlerGuard } from "@nestjs/throttler";
import { Model, Types } from "mongoose";

const supertest = require("supertest") as typeof import("supertest");
import { PaymentController } from "../payment.controller";
import { PaymentService } from "../payment.service";
import {
  Booking,
  BookingSchema,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { RedisService } from "@src/redis/redis.service";
import { TicketService } from "@src/ticket/ticket.service";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { QueueService } from "@src/queue/queue.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { CurrencyService } from "@src/currency/currency.service";
import { MailService } from "@src/services/mail.service";

// ─── Fake JWT user injected by overridden AuthGuard ───────────────────────────
const FAKE_USER_ID = new Types.ObjectId();
const FAKE_JWT_PAYLOAD = {
  userId: FAKE_USER_ID.toHexString(),
  email: "integration@test.local",
  role: "user",
};

const getPaymentIntegrationMongoUri = (): string => {
  const mongoUri =
    process.env.PAYMENT_INTEGRATION_MONGODB_URI ?? process.env.MONGODB_URI;
  if (!mongoUri) {
    throw new Error(
      "PAYMENT_INTEGRATION_MONGODB_URI or MONGODB_URI is required for payment integration tests"
    );
  }
  return mongoUri;
};

// ─── Shared mutable Redis mock ────────────────────────────────────────────────
// Tests spy/override individual methods to inject failures.
// Reset to healthy defaults in beforeEach.
const redisClient = {
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(0),
  eval: jest.fn().mockResolvedValue(null),
  sMembers: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(1),
  incrBy: jest.fn().mockResolvedValue(0),
  decrBy: jest.fn().mockResolvedValue(0),
  scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
};

// ─── Test infrastructure ──────────────────────────────────────────────────────
let app: INestApplication;
let testingModule: TestingModule;
let paymentService: PaymentService;
let bookingModel: Model<Booking>;
let paymentModel: Model<any>;

beforeAll(async () => {
  const mongoUri = getPaymentIntegrationMongoUri();
  testingModule = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(mongoUri, { dbName: "payment_integration_test" }),
      MongooseModule.forFeature([
        { name: Booking.name, schema: BookingSchema },
        { name: Payment.name, schema: PaymentSchema },
        { name: Zone.name, schema: ZoneSchema },
        { name: Ticket.name, schema: TicketSchema },
      ]),
    ],
    controllers: [PaymentController],
    providers: [
      PaymentService,
      { provide: RedisService, useValue: { client: redisClient } },
      {
        provide: TicketService,
        useValue: {
          createTicketsFromBooking: jest.fn().mockResolvedValue([]),
          publishTicketCreation: jest.fn().mockResolvedValue(undefined),
          generateMissingQRCodesForBooking: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MailService,
        useValue: { sendBookingConfirmation: jest.fn() },
      },
      { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
      {
        provide: QueueService,
        useValue: { addJob: jest.fn().mockResolvedValue(undefined) },
      },
      {
        provide: MetricsService,
        useValue: {
          paymentsTotal: { inc: jest.fn() },
          refundFailuresTotal: { inc: jest.fn() },
        },
      },
      {
        provide: CurrencyService,
        useValue: { getVndPerUsd: jest.fn().mockResolvedValue(25_000) },
      },
    ],
  })
    // Bypass JWT auth — inject fake user into request.user
    .overrideGuard(AuthGuard("jwt"))
    .useValue({
      canActivate: (ctx: ExecutionContext) => {
        ctx.switchToHttp().getRequest().user = FAKE_JWT_PAYLOAD;
        return true;
      },
    })
    // Disable throttler
    .overrideGuard(ThrottlerGuard)
    .useValue({ canActivate: () => true })
    .compile();

  paymentService = testingModule.get(PaymentService);
  bookingModel = testingModule.get(getModelToken(Booking.name));
  paymentModel = testingModule.get(getModelToken(Payment.name));

  app = testingModule.createNestApplication({ rawBody: true });
  await app.init();
}, 90_000); // MongoMemoryReplSet có thể mất 60s+ để tải binary lần đầu

afterAll(async () => {
  await app?.close();
});

beforeEach(async () => {
  // Xóa dữ liệu giữa các test
  await bookingModel.deleteMany({});
  await paymentModel.deleteMany({});

  // Reset Redis về trạng thái khỏe mạnh
  redisClient.set.mockResolvedValue("OK");
  redisClient.get.mockResolvedValue(null);
  redisClient.eval.mockResolvedValue(null);
  redisClient.sMembers.mockResolvedValue([]);
  redisClient.expire.mockResolvedValue(1);
  redisClient.del.mockResolvedValue(0);

  jest.restoreAllMocks();
});

// ─── Helper: gửi webhook request qua HTTP ────────────────────────────────────
// verifyWebhook được spy để trả về event thật sự — Stripe signature verification
// là logic của Stripe SDK (đã được test trong payment.controller.spec.ts).
// Ở đây ta test business logic: idempotency fallback, DB writes, refundHistory.
const sendWebhookEvent = async (
  paymentSvc: PaymentService,
  httpServer: unknown,
  eventPayload: object
) => {
  // Bypass signature verification — trả về event object thật
  jest.spyOn(paymentSvc, "verifyWebhook").mockReturnValue(eventPayload as any);

  return supertest(httpServer)
    .post("/payment/webhook")
    .set("stripe-signature", "sig=bypassed_for_integration_test")
    .set("Content-Type", "application/json")
    .send(Buffer.from(JSON.stringify(eventPayload)));
};

// ─── Helper: tạo booking seed ─────────────────────────────────────────────────
const seedBooking = (overrides: Partial<Record<string, unknown>> = {}) =>
  bookingModel.create({
    bookingCode: `BK-INTEG-${Date.now()}`,
    userId: FAKE_USER_ID,
    eventId: new Types.ObjectId(),
    zoneId: new Types.ObjectId(),
    quantity: 1,
    pricePerTicket: 500_000,
    totalPrice: 500_000,
    status: BookingStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    customerEmail: "integration@test.local",
    expiresAt: new Date(Date.now() + 3_600_000),
    isDeleted: false,
    ...overrides,
  });

// ─── Helper: tạo payment seed ─────────────────────────────────────────────────
const seedPayment = (
  bookingId: Types.ObjectId,
  overrides: Partial<Record<string, unknown>> = {}
) =>
  paymentModel.create({
    bookingId,
    userId: FAKE_USER_ID,
    eventId: new Types.ObjectId(),
    amount: 500_000,
    currency: "vnd",
    paymentMethod: "paypal",
    status: "pending",
    isDeleted: false,
    ...overrides,
  });

// ══════════════════════════════════════════════════════════════════════════════
// PAY-001 — Webhook: MongoDB fallback khi Redis HOÀN TOÀN down
// ══════════════════════════════════════════════════════════════════════════════

describe("PAY-001 — Webhook idempotency: MongoDB fallback khi Redis DOWN", () => {
  it("should return 200 deduplicated (không double-process) khi Redis down nhưng booking đã CONFIRMED trong MongoDB", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    const paymentIntentId = "pi_integ_already_paid_001";

    // Seed: booking đã được xử lý (CONFIRMED + PAID) — event này đã được process rồi
    await seedBooking({ stripePaymentIntentId: paymentIntentId });

    // Inject lỗi Redis — toàn bộ Redis down
    redisClient.set.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:6379")
    );
    redisClient.get.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:6379")
    );

    // Spy: handleCheckoutSessionCompleted KHÔNG được gọi (idempotency hoạt động)
    const businessLogicSpy = jest
      .spyOn(paymentService, "handleCheckoutSessionCompleted")
      .mockResolvedValue(undefined);

    // ── Act ────────────────────────────────────────────────────────────────────
    const response = await sendWebhookEvent(
      paymentService,
      app.getHttpServer(),
      {
        id: "evt_integ_dedupe_001",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_integ_001",
            payment_intent: paymentIntentId,
            status: "complete",
          },
        },
      }
    );

    // ── Assert ─────────────────────────────────────────────────────────────────
    // Không được 503 — Redis down không được kích hoạt Stripe retry storm
    expect(response.status).toBe(200);
    // Phải deduplicate thành công qua MongoDB fallback
    expect(response.body.deduplicated).toBe(true);
    // Business logic KHÔNG được chạy lại — tiền không bị thu 2 lần
    expect(businessLogicSpy).not.toHaveBeenCalled();
  });

  it("should return 200 (không 503) khi Redis down và event là mới — xử lý bình thường qua DB guards", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    // Không có booking nào trong DB → checkWebhookIdempotencyFromDB trả về "new"
    redisClient.set.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:6379")
    );
    redisClient.get.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:6379")
    );

    // Mock business logic để tránh đi sâu vào flow thanh toán
    const businessLogicSpy = jest
      .spyOn(paymentService, "handleCheckoutSessionCompleted")
      .mockResolvedValue(undefined);

    // ── Act ────────────────────────────────────────────────────────────────────
    const response = await sendWebhookEvent(
      paymentService,
      app.getHttpServer(),
      {
        id: "evt_integ_new_redis_down",
        type: "checkout.session.completed",
        data: {
          object: {
            id: "cs_integ_002",
            payment_intent: "pi_integ_brand_new_no_booking",
            status: "complete",
          },
        },
      }
    );

    // ── Assert ─────────────────────────────────────────────────────────────────
    // Quan trọng nhất: KHÔNG phải 503 → Stripe không retry storm
    expect(response.status).not.toBe(503);
    expect(response.status).toBe(200);
    // Business logic được gọi (event mới, cần xử lý)
    expect(businessLogicSpy).toHaveBeenCalledTimes(1);
  });

  it("should return 503 chỉ khi CẢ Redis lẫn MongoDB đều down (truly unavailable)", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    // Redis down
    redisClient.set.mockRejectedValue(new Error("ECONNREFUSED"));

    // MongoDB cũng down — spy lên checkWebhookIdempotencyFromDB
    jest
      .spyOn(paymentService, "checkWebhookIdempotencyFromDB")
      .mockRejectedValue(new Error("MongoNetworkError: connection timed out"));

    // ── Act ────────────────────────────────────────────────────────────────────
    const response = await sendWebhookEvent(
      paymentService,
      app.getHttpServer(),
      {
        id: "evt_integ_total_outage",
        type: "checkout.session.completed",
        data: {
          object: { id: "cs_integ_003", payment_intent: "pi_total_outage" },
        },
      }
    );

    // ── Assert ─────────────────────────────────────────────────────────────────
    // Khi THẬT SỰ không thể xử lý → 503 để Stripe retry sau khi hệ thống phục hồi
    expect(response.status).toBe(503);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PAY-003 — PayPal Atomicity: PendingConfirmation phải tồn tại khi DB write fail
// ══════════════════════════════════════════════════════════════════════════════

describe("PAY-003 — PayPal atomicity: PendingConfirmation record khi DB write thất bại", () => {
  it("should write PendingConfirmation vào MongoDB TRƯỚC KHI processPaypalPayment, ngay cả khi DB transaction sau đó fail", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    const orderId = "PAYPALORDERINTEG003A";
    const captureId = "CAPTUREINTEG003A";

    // Seed: booking PENDING + payment record pending
    const booking = await seedBooking({
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
    });
    const payment = await seedPayment(booking._id, {
      paypalOrderId: orderId,
    });

    // Mock PayPal capture thành công — tiền đã bị thu từ khách hàng
    const mockCaptureResponse = {
      result: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: captureId,
                  status: "COMPLETED",
                  amount: { currency_code: "USD", value: "20.00" },
                },
              ],
            },
          },
        ],
      },
    };
    jest
      .spyOn((paymentService as any).paypalClient, "execute")
      .mockResolvedValue(mockCaptureResponse);

    // Inject lỗi DB: processPaypalPayment ném lỗi (mô phỏng DB crash sau khi tiền đã bị thu)
    jest
      .spyOn(paymentService as any, "processPaypalPayment")
      .mockRejectedValue(
        new Error("MongoNetworkError: DB connection lost after capture")
      );

    // ── Act ────────────────────────────────────────────────────────────────────
    // Endpoint sẽ trả về lỗi (4xx/5xx) vì DB write thất bại — điều này là đúng
    const finalizeResponse = await supertest(app.getHttpServer())
      .post(`/payment/${orderId}/finalize`)
      .set("Authorization", "Bearer fake-jwt-token");

    // Chấp nhận bất kỳ status lỗi nào (4xx hoặc 5xx) — quan trọng là PendingConfirmation đã được ghi
    expect(finalizeResponse.status).toBeGreaterThanOrEqual(400);

    // ── Assert: PendingConfirmation phải đã được ghi vào MongoDB ──────────────
    // Đây là bảo đảm quan trọng nhất của PAY-003:
    // "Tiền đã bị thu" phải để lại dấu vết, kể cả khi transaction chính fail
    const updatedPayment = await paymentModel.findById(payment._id).lean();

    expect(updatedPayment).not.toBeNull();
    expect(updatedPayment!.metadata).toBeDefined();
    expect(updatedPayment!.metadata.captureStatus).toBe("PendingConfirmation");
    expect(updatedPayment!.metadata.captureId).toBe(captureId);
    expect(updatedPayment!.metadata.capturedAt).toBeDefined();

    // ── Assert: Booking KHÔNG được CONFIRMED (tiền chưa được xác nhận vào hệ thống) ──
    const bookingAfter = await bookingModel
      .findById(booking._id)
      .select("status paymentStatus")
      .lean();

    expect(bookingAfter!.status).toBe(BookingStatus.PENDING);
    expect(bookingAfter!.paymentStatus).toBe(PaymentStatus.UNPAID);
  });

  it("should NOT release PayPal lock khi capture thành công nhưng DB write fail (PAY-002)", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    const orderId = "PAYPALLOCKTEST00001A";

    const booking = await seedBooking({
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
    });
    await seedPayment(booking._id, {
      paypalOrderId: orderId,
    });

    jest
      .spyOn((paymentService as any).paypalClient, "execute")
      .mockResolvedValue({
        result: {
          id: orderId,
          status: "COMPLETED",
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: "CAP-LOCK-TEST",
                    status: "COMPLETED",
                    amount: { currency_code: "USD", value: "20.00" },
                  },
                ],
              },
            },
          ],
        },
      });

    jest
      .spyOn(paymentService as any, "processPaypalPayment")
      .mockRejectedValue(new Error("MongoNetworkError: DB crash"));

    const releaseEvalCalls: unknown[][] = [];
    redisClient.eval.mockImplementation((...args: unknown[]) => {
      releaseEvalCalls.push(args);
      return Promise.resolve(null);
    });

    // ── Act ────────────────────────────────────────────────────────────────────
    await supertest(app.getHttpServer())
      .post(`/payment/${orderId}/finalize`)
      .set("Authorization", "Bearer fake-jwt-token");

    // ── Assert: eval() KHÔNG được gọi với paypal:lock key để release ──────────
    const lockReleaseCalls = releaseEvalCalls.filter(
      (args) =>
        Array.isArray(args[1]) ||
        (args[1] &&
          typeof args[1] === "object" &&
          Array.isArray((args[1] as any).keys) &&
          (args[1] as any).keys[0]?.includes("paypal:lock:"))
    );
    // Lock phải được GIỮ — không được release khi capture đã thành công
    expect(lockReleaseCalls.length).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// PAY-005 — Partial Refund: refundHistory được cập nhật (không bị thoát sớm)
// ══════════════════════════════════════════════════════════════════════════════

describe("PAY-005 — Partial refund: refundHistory cập nhật đúng (PAY-005 guard fix)", () => {
  it("should cập nhật refundHistory khi charge.refunded=false nhưng amount_refunded>0 (partial refund)", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    const paymentIntentId = "pi_integ_partial_refund_005";
    const fullAmount = 500_000; // VND (zero-decimal)
    const refundedAmount = 100_000; // partial refund

    // Seed: booking CONFIRMED + PAID
    await seedBooking({ stripePaymentIntentId: paymentIntentId });

    // Seed: payment record
    await seedPayment(new Types.ObjectId(), {
      stripePaymentIntentId: paymentIntentId,
      status: "succeeded",
    });

    // Webhook charge.refunded — đây là partial refund:
    //   charge.refunded === false  (chỉ true khi full refund)
    //   amount_refunded > 0        (đã refund một phần)

    // ── Act ────────────────────────────────────────────────────────────────────
    const response = await sendWebhookEvent(
      paymentService,
      app.getHttpServer(),
      {
        id: "evt_integ_partial_refund",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_integ_005",
            object: "charge",
            payment_intent: paymentIntentId,
            refunded: false, // partial refund: KHÔNG phải true
            amount: fullAmount,
            amount_refunded: refundedAmount,
            currency: "vnd",
          },
        },
      }
    );

    // ── Assert ─────────────────────────────────────────────────────────────────
    expect(response.status).toBe(200);

    // Booking phải có refundHistory entry
    const booking = await bookingModel
      .findOne({ stripePaymentIntentId: paymentIntentId })
      .lean();

    expect(booking).not.toBeNull();
    expect(booking!.refundHistory).toBeDefined();
    expect(booking!.refundHistory).toHaveLength(1);
    expect(booking!.refundHistory[0].amount).toBe(refundedAmount);

    // Booking vẫn CONFIRMED (chưa bị cancel, chỉ partial refund)
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
    // totalRefunded đã được cập nhật
    expect(booking!.totalRefunded).toBe(refundedAmount);
  });

  it("should KHÔNG cập nhật refundHistory khi amount_refunded=0 (guard đúng, thoát sớm)", async () => {
    // ── Arrange ────────────────────────────────────────────────────────────────
    const paymentIntentId = "pi_integ_zero_refund";
    await seedBooking({ stripePaymentIntentId: paymentIntentId });

    // ── Act ────────────────────────────────────────────────────────────────────
    const response = await sendWebhookEvent(
      paymentService,
      app.getHttpServer(),
      {
        id: "evt_integ_zero_refund",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_integ_zero",
            object: "charge",
            payment_intent: paymentIntentId,
            refunded: false,
            amount: 500_000,
            amount_refunded: 0, // Không có gì được refund
            currency: "vnd",
          },
        },
      }
    );

    // ── Assert ─────────────────────────────────────────────────────────────────
    expect(response.status).toBe(200);

    // Booking KHÔNG bị thay đổi — guard amount_refunded <= 0 hoạt động đúng
    const booking = await bookingModel
      .findOne({ stripePaymentIntentId: paymentIntentId })
      .lean();

    expect(booking!.refundHistory).toHaveLength(0);
    expect(booking!.totalRefunded ?? 0).toBe(0);
    expect(booking!.status).toBe(BookingStatus.CONFIRMED);
  });

  it("should KHÔNG thoát sớm với partial refund (verify PAY-005 guard fix: dùng amount_refunded thay vì charge.refunded)", async () => {
    // Test này trực tiếp verify rằng guard cũ `if (!charge.refunded) return`
    // đã được sửa thành `if (!charge.amount_refunded || charge.amount_refunded <= 0) return`.
    //
    // Trước fix: charge.refunded=false → return sớm → partial refund bị nuốt im lặng.
    // Sau fix: amount_refunded=100_000 > 0 → tiếp tục xử lý → refundHistory được update.

    const paymentIntentId = "pi_integ_guard_verify";
    await seedBooking({
      stripePaymentIntentId: paymentIntentId,
      totalRefunded: 0,
    });
    await seedPayment(new Types.ObjectId(), {
      stripePaymentIntentId: paymentIntentId,
      status: "succeeded",
    });

    const response = await sendWebhookEvent(
      paymentService,
      app.getHttpServer(),
      {
        id: "evt_integ_guard_verify",
        type: "charge.refunded",
        data: {
          object: {
            id: "ch_integ_guard",
            object: "charge",
            payment_intent: paymentIntentId,
            refunded: false, // cờ cũ: false = partial → logic cũ thoát sớm
            amount: 500_000,
            amount_refunded: 200_000, // có refund thật sự
            currency: "vnd",
          },
        },
      }
    );

    expect(response.status).toBe(200);

    const booking = await bookingModel
      .findOne({ stripePaymentIntentId: paymentIntentId })
      .lean();

    // Chứng minh logic KHÔNG thoát sớm: refundHistory đã được cập nhật
    expect(booking!.refundHistory).toHaveLength(1);
    expect(booking!.refundHistory[0].amount).toBe(200_000);
    expect(booking!.totalRefunded).toBe(200_000);
  });
});
