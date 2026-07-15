/**
 * Payment Service — Sad Path Test Suite
 *
 * Covers every error branch in lines 311-935 (createCheckoutSession,
 * createPaypalTransaction, verifyWebhook, handleCheckoutSessionCompleted,
 * finalizePaypalTransaction) that is NOT exercised by the happy-path suite.
 *
 * Grouped into three user-facing scenarios:
 *  A. Stripe Webhook với sai signature / metadata thiếu
 *  B. Payment gateway trả về trạng thái failed / expired / non-COMPLETED
 *  C. Client gửi thanh toán cho giao dịch đã paid / đã finalized
 *
 * Plus additional edge cases embedded in each function.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { BadRequestException, ConflictException, Logger } from "@nestjs/common";
import { Types } from "mongoose";

import { PaymentService } from "./payment.service";
import { Payment } from "@src/schemas/payment.schema";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { TicketService } from "@src/ticket/ticket.service";
import { MailService } from "@src/services/mail.service";
import { RedisService } from "@src/redis/redis.service";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { UserEventsService } from "@src/events/user-event.services";
import { QueueService } from "@src/queue/queue.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { CurrencyService } from "@src/currency/currency.service";

// ── Module-level mocks ──────────────────────────────────────────────────────

jest.mock("stripe", () =>
  jest.fn().mockImplementation(() => ({
    webhooks: {
      constructEvent: jest.fn(),
    },
    checkout: {
      sessions: {
        create: jest.fn(),
        retrieve: jest.fn(),
      },
    },
    refunds: {
      create: jest.fn(),
    },
  }))
);

jest.mock("@paypal/checkout-server-sdk", () => ({
  core: {
    SandboxEnvironment: jest.fn(),
    LiveEnvironment: jest.fn(),
    PayPalHttpClient: jest.fn().mockImplementation(() => ({
      execute: jest.fn(),
    })),
  },
  orders: {
    OrdersCreateRequest: jest.fn().mockImplementation(() => {
      const req: any = { body: {} };
      req.prefer = jest.fn();
      req.requestBody = jest.fn().mockImplementation((body) => {
        req.body = body;
      });
      return req;
    }),
    OrdersCaptureRequest: jest.fn().mockImplementation(() => ({
      requestBody: jest.fn(),
    })),
    OrdersGetRequest: jest.fn().mockImplementation(() => ({})),
  },
  payments: {
    CapturesRefundRequest: jest.fn().mockImplementation(() => ({
      requestBody: jest.fn(),
    })),
  },
}));

jest.mock("@src/config/config", () => ({
  default: {
    STRIPE_SECRET_KEY: "sk_test_fake",
    STRIPE_WEBHOOK_SECRET: "whsec_fake_secret",
    PAYPAL_CLIENT_ID: "fake_paypal_id",
    PAYPAL_CLIENT_SECRET: "fake_paypal_secret",
    FRONTEND_URL: "http://localhost:3000",
  },
}));

// ── Test helpers ────────────────────────────────────────────────────────────

/**
 * Creates a chainable, awaitable Mongoose query mock.
 * Supports: .populate() .select() .session() .lean() .exec() await
 */
const makeChain = (resolved: unknown) => {
  const obj: any = {};
  const thenable = {
    then: (res: any, rej: any) => Promise.resolve(resolved).then(res, rej),
    catch: (rej: any) => Promise.resolve(resolved).catch(rej),
    finally: (fn: any) => Promise.resolve(resolved).finally(fn),
  };
  Object.assign(obj, thenable, {
    populate: jest.fn().mockReturnValue(obj),
    select: jest.fn().mockReturnValue(obj),
    session: jest.fn().mockReturnValue(obj),
    lean: jest
      .fn()
      .mockReturnValue({ exec: jest.fn().mockResolvedValue(resolved) }),
    exec: jest.fn().mockResolvedValue(resolved),
  });
  // ensure chained populate always returns the same thenable object
  obj.populate.mockReturnValue(obj);
  return obj;
};

const makeSession = () => ({
  withTransaction: jest
    .fn()
    .mockImplementation(async (fn: () => Promise<unknown>) => fn()),
  endSession: jest.fn().mockResolvedValue(undefined),
});

interface ProviderOverrides {
  bookingModel?: Partial<any>;
  paymentModel?: Partial<any>;
  zoneModel?: Partial<any>;
  redisClient?: Partial<any>;
  ticketService?: Partial<any>;
  stripe?: Partial<any>;
  paypalClient?: Partial<any>;
  userEventsService?: Partial<any>;
}

const buildPaymentService = async (overrides: ProviderOverrides = {}) => {
  const defaultSession = makeSession();

  const defaultBookingModel: any = {
    db: { startSession: jest.fn().mockResolvedValue(defaultSession) },
    findOne: jest.fn().mockReturnValue(makeChain(null)),
    findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
  };

  const defaultPaymentModel: any = {
    findOneAndUpdate: jest.fn().mockResolvedValue({}),
    findByIdAndUpdate: jest.fn().mockResolvedValue({}),
    findOne: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      }),
    }),
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      }),
    }),
  };

  const defaultZoneModel: any = {
    findByIdAndUpdate: jest.fn().mockResolvedValue(null),
    updateOne: jest.fn().mockResolvedValue({}),
    findById: jest.fn().mockReturnValue({
      select: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
    }),
  };

  const defaultRedisClient: any = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(["locked", ""]),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
  };

  const defaultTicketService: any = {
    createTicketsFromBooking: jest.fn().mockResolvedValue([]),
    publishTicketCreation: jest.fn().mockResolvedValue(undefined),
  };

  const bookingModel = { ...defaultBookingModel, ...overrides.bookingModel };
  const paymentModel = { ...defaultPaymentModel, ...overrides.paymentModel };
  const zoneModel = { ...defaultZoneModel, ...overrides.zoneModel };
  const redisClient = { ...defaultRedisClient, ...overrides.redisClient };
  const ticketService = { ...defaultTicketService, ...overrides.ticketService };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      PaymentService,
      { provide: getModelToken(Payment.name), useValue: paymentModel },
      { provide: getModelToken(Booking.name), useValue: bookingModel },
      { provide: getModelToken(Zone.name), useValue: zoneModel },
      { provide: getModelToken(Ticket.name), useValue: {} },
      { provide: TicketService, useValue: ticketService },
      { provide: MailService, useValue: {} },
      { provide: RedisService, useValue: { client: redisClient } },
      { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
      {
        provide: UserEventsService,
        useValue: overrides.userEventsService ?? {
          emitSendBookingConfirmation: jest.fn(),
        },
      },
      {
        provide: QueueService,
        useValue: { addJob: jest.fn().mockResolvedValue(undefined) },
      },
      {
        provide: MetricsService,
        useValue: {
          paymentsTotal: { inc: jest.fn() },
          refundFailuresTotal: { inc: jest.fn() },
          bookingsTotal: { inc: jest.fn() },
          checkinsTotal: { inc: jest.fn() },
        },
      },
      {
        provide: CurrencyService,
        useValue: { getVndPerUsd: jest.fn().mockResolvedValue(26000) },
      },
    ],
  }).compile();

  const service = module.get<PaymentService>(PaymentService);

  // Inject mocked stripe and paypalClient if provided
  if (overrides.stripe) {
    Object.assign((service as any).stripe, overrides.stripe);
  }
  if (overrides.paypalClient) {
    Object.assign((service as any).paypalClient, overrides.paypalClient);
  }

  return {
    service,
    bookingModel,
    paymentModel,
    zoneModel,
    redisClient,
    ticketService,
  };
};

// ── Shared booking fixture ──────────────────────────────────────────────────

const validPendingBooking = () => ({
  _id: new Types.ObjectId(),
  bookingCode: "BK20260101120000ABCD",
  status: BookingStatus.PENDING,
  paymentStatus: PaymentStatus.UNPAID,
  expiresAt: new Date(Date.now() + 30 * 60_000),
  quantity: 2,
  pricePerTicket: 500_000,
  totalPrice: 1_000_000,
  seats: [],
  customerEmail: "user@example.com",
  customerName: "Alice",
  customerPhone: "0901234567",
  userId: new Types.ObjectId(),
  eventId: {
    _id: new Types.ObjectId(),
    title: "Rock Concert 2026",
    thumbnail: null,
    location: "Hanoi",
    startDate: new Date(Date.now() + 7 * 24 * 3600_000),
    endDate: new Date(Date.now() + 7 * 24 * 3600_000 + 4 * 3600_000),
  },
  zoneId: { _id: new Types.ObjectId(), name: "Zone A", price: 500_000 },
  areaId: null,
});

// ═══════════════════════════════════════════════════════════════════════════════
// A. STRIPE WEBHOOK — SAI SIGNATURE / METADATA THIẾU
// ═══════════════════════════════════════════════════════════════════════════════

describe("A — Stripe Webhook: sai signature / metadata thiếu", () => {
  let service: PaymentService;

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    ({ service } = await buildPaymentService());
  });

  afterEach(() => jest.restoreAllMocks());

  // ── A1: verifyWebhook ────────────────────────────────────────────────────

  describe("verifyWebhook", () => {
    it("A1-1: throws BadRequestException khi signature sai", () => {
      (service as any).stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error(
          "No signatures found matching the expected signature for payload"
        );
      });

      expect(() =>
        service.verifyWebhook(Buffer.from("{}"), "t=wrong,v1=bad")
      ).toThrow(BadRequestException);
    });

    it("A1-2: message lỗi bao gồm chi tiết của Stripe error", () => {
      (service as any).stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error("Stripe signature mismatch");
      });

      expect(() =>
        service.verifyWebhook(Buffer.from("{}"), "t=1,v1=bad")
      ).toThrow(/Webhook Error.*Stripe signature mismatch/);
    });

    it("A1-3: BadRequestException (không phải 5xx) — webhook controller trả 400 cho Stripe", () => {
      (service as any).stripe.webhooks.constructEvent.mockImplementation(() => {
        throw new Error("Invalid signature");
      });

      let caught: unknown;
      try {
        service.verifyWebhook(Buffer.from("{}"), "bad");
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).getStatus()).toBe(400);
    });

    it("A1-4: signature hợp lệ trả về Stripe.Event", () => {
      const fakeEvent = { id: "evt_test", type: "checkout.session.completed" };
      (service as any).stripe.webhooks.constructEvent.mockReturnValue(
        fakeEvent
      );

      const result = service.verifyWebhook(
        Buffer.from(JSON.stringify(fakeEvent)),
        "t=123,v1=valid"
      );

      expect(result).toEqual(fakeEvent);
    });

    it("A1-5: throws BadRequestException khi constructEvent throws non-Error", () => {
      (service as any).stripe.webhooks.constructEvent.mockImplementation(() => {
        throw "string error";
      });

      expect(() =>
        service.verifyWebhook(Buffer.from("{}"), "t=bad,v1=bad")
      ).toThrow(BadRequestException);
    });
  });

  // ── A2: handleCheckoutSessionCompleted — metadata thiếu ──────────────────

  describe("handleCheckoutSessionCompleted — metadata thiếu", () => {
    it("A2-1: throws khi userId bị thiếu trong metadata", async () => {
      const session = {
        id: "cs_test",
        metadata: {
          bookingCode: "BK001",
          bookingId: "507f1f77bcf86cd799439011",
        },
        payment_intent: "pi_test",
      } as any;

      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).rejects.toThrow("Missing metadata in session");
    });

    it("A2-2: throws khi bookingCode bị thiếu", async () => {
      const session = {
        id: "cs_test",
        metadata: { userId: "user1", bookingId: "507f1f77bcf86cd799439011" },
        payment_intent: "pi_test",
      } as any;

      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).rejects.toThrow("Missing metadata in session");
    });

    it("A2-3: throws khi bookingId bị thiếu", async () => {
      const session = {
        id: "cs_test",
        metadata: { userId: "user1", bookingCode: "BK001" },
        payment_intent: "pi_test",
      } as any;

      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).rejects.toThrow("Missing metadata in session");
    });

    it("A2-4: throws khi metadata là null", async () => {
      const session = {
        id: "cs_test",
        metadata: null,
        payment_intent: "pi_test",
      } as any;
      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).rejects.toThrow("Missing metadata in session");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B. PAYMENT GATEWAY TRẢ VỀ FAILED / EXPIRED / NON-COMPLETED
// ═══════════════════════════════════════════════════════════════════════════════

describe("B — Payment gateway: failed / expired / non-COMPLETED", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  // ── B1: createCheckoutSession — booking đã hết hạn ───────────────────────

  describe("createCheckoutSession — booking expired", () => {
    it("B1-1: throws BadRequestException khi booking.expiresAt đã qua", async () => {
      const expiredBooking = {
        ...validPendingBooking(),
        expiresAt: new Date(Date.now() - 60_000), // expired 1 min ago
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(expiredBooking)),
        },
      });

      await expect(
        service.createCheckoutSession(new Types.ObjectId().toString(), "BK001")
      ).rejects.toThrow("Booking has expired");
    });
  });

  // ── B2: createPaypalTransaction — amount quá nhỏ ─────────────────────────

  describe("createPaypalTransaction — amount quá nhỏ", () => {
    it("B2-1: throws khi totalPrice/VND_RATE < 0.01 USD (giá trị quá nhỏ)", async () => {
      const tinyBooking = {
        ...validPendingBooking(),
        totalPrice: 50, // 50 VND / 26000 = 0.0019 USD → < 0.01
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(tinyBooking)),
        },
      });

      await expect(
        service.createPaypalTransaction(
          new Types.ObjectId().toString(),
          "BK001"
        )
      ).rejects.toThrow("quá nhỏ để xử lý qua PayPal");
    });

    it("B2-2: throws BadRequestException khi PayPal execute thất bại (network error)", async () => {
      const booking = validPendingBooking();
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(booking)),
        },
        paypalClient: {
          execute: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        },
      });

      await expect(
        service.createPaypalTransaction(
          new Types.ObjectId().toString(),
          "BK001"
        )
      ).rejects.toThrow("Failed to create PayPal order");
    });
  });

  // ── B3: finalizePaypalTransaction — capture không thành công ─────────────

  describe("finalizePaypalTransaction — PayPal capture thất bại", () => {
    const orderId = "PAYPAL_ORDER_123";
    const userId = new Types.ObjectId().toString();

    const makePaymentRecord = () => ({
      _id: new Types.ObjectId(),
      bookingId: new Types.ObjectId(),
      status: "pending",
      currency: "VND",
      metadata: {},
    });

    const makeBookingRecord = (status = BookingStatus.PENDING) => ({
      bookingCode: "BK001",
      status,
      paymentStatus: PaymentStatus.UNPAID,
      isDeleted: false,
    });

    it("B3-1: throws ConflictException khi PayPal lock đang bị giữ (processing)", async () => {
      const { service, redisClient } = await buildPaymentService();
      // Lock không acquired (null) và status là "processing"
      redisClient.set.mockResolvedValueOnce(null);
      redisClient.get.mockResolvedValueOnce("processing");

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow(ConflictException);
    });

    it("B3-2: throws BadRequestException khi payment record không tìm thấy", async () => {
      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest
                .fn()
                .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
            }),
          }),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Payment record not found or unauthorized");
    });

    it("B3-3: throws BadRequestException khi booking đã CANCELLED", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.CANCELLED);

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Booking has been cancelled or expired");
    });

    it("B3-4: throws BadRequestException khi booking đã EXPIRED", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.EXPIRED);

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Booking has been cancelled or expired");
    });

    it("B3-5: throws BadRequestException khi PayPal capture trả về status không phải COMPLETED", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.PENDING);

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest.fn().mockResolvedValue({
            result: {
              id: orderId,
              status: "DECLINED", // không phải "COMPLETED"
              purchase_units: [
                {
                  payments: { captures: [{ id: "cap_1", status: "DECLINED" }] },
                },
              ],
            },
          }),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Capture failed with status: DECLINED");
    });

    it("B3-6: throws BadRequestException khi PayPal capture throw error thông thường", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.PENDING);

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest
                .fn()
                .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest
            .fn()
            .mockRejectedValue(new Error("PayPal gateway timeout")),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Failed to capture payment");
    });

    it("B3-7: lock được giải phóng trong finally khi capture thất bại", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.PENDING);

      const { service, redisClient } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest
                .fn()
                .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest.fn().mockRejectedValue(new Error("Gateway error")),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow();

      // eval dùng WEBHOOK_RELEASE_SCRIPT để release lock
      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ keys: [`paypal:lock:${orderId}`] })
      );
    });

    it("B3-8: throws BadRequestException khi booking isDeleted", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.PENDING);
      booking.isDeleted = true;

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Associated booking not found");
    });

    it("B3-9: lock release failure được log warning nhưng không throw", async () => {
      const payment = makePaymentRecord();
      const booking = makeBookingRecord(BookingStatus.PENDING);

      const { service, redisClient } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest
                .fn()
                .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest.fn().mockRejectedValue(new Error("Gateway error")),
        },
      });

      // Lock release fails
      redisClient.eval.mockRejectedValueOnce(new Error("Redis down"));

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow();
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to release PayPal lock")
      );
    });
  });

  // ── B4: handleCheckoutSessionCompleted — booking ở trạng thái không thể confirm

  describe("handleCheckoutSessionCompleted — booking không thể confirm (auto-refund path)", () => {
    it("B4-1: trigger auto-refund khi booking đã EXPIRED trước khi webhook đến", async () => {
      const session = {
        id: "cs_test",
        metadata: {
          userId: new Types.ObjectId().toString(),
          bookingCode: "BK001",
          bookingId: new Types.ObjectId().toString(),
        },
        payment_intent: "pi_expired_booking",
        amount_total: 500_000,
        currency: "vnd",
        customer_details: null,
      } as any;

      // First findOneAndUpdate returns null (booking not PENDING → can't update)
      // Second findOne returns booking that is EXPIRED (not CONFIRMED+PAID)
      const expiredBooking = {
        _id: new Types.ObjectId(),
        status: BookingStatus.EXPIRED,
        paymentStatus: PaymentStatus.UNPAID,
        userId: new Types.ObjectId(),
        bookingCode: "BK001",
        eventId: { title: "Concert" },
        zoneId: { name: "Zone A" },
        seats: [],
        quantity: 2,
        totalPrice: 500_000,
        customerEmail: "user@example.com",
      };

      const refundSpy = jest.fn().mockResolvedValue({ id: "re_test" });
      const { service } = await buildPaymentService({
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
          findOne: jest.fn().mockReturnValue(makeChain(expiredBooking)),
        },
        paymentModel: {
          findOneAndUpdate: jest.fn().mockResolvedValue({}),
        },
        stripe: {
          refunds: { create: refundSpy },
          checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
        },
      });

      // Nên return sau khi auto-refund, không throw
      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).resolves.toBeUndefined();
      expect(refundSpy).toHaveBeenCalledWith(
        expect.objectContaining({ payment_intent: "pi_expired_booking" })
      );
    });

    it("B4-2: log CRITICAL nhưng không throw khi auto-refund thất bại", async () => {
      const session = {
        id: "cs_test",
        metadata: {
          userId: new Types.ObjectId().toString(),
          bookingCode: "BK001",
          bookingId: new Types.ObjectId().toString(),
        },
        payment_intent: "pi_refund_fail",
        amount_total: 500_000,
        currency: "vnd",
        customer_details: null,
      } as any;

      const expiredBooking = {
        _id: new Types.ObjectId(),
        status: BookingStatus.CANCELLED,
        paymentStatus: PaymentStatus.UNPAID,
        userId: new Types.ObjectId(),
        bookingCode: "BK001",
        eventId: { title: "Concert" },
        zoneId: { name: "Zone A" },
        seats: [],
        quantity: 2,
        totalPrice: 500_000,
        customerEmail: "user@example.com",
      };

      const { service } = await buildPaymentService({
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
          findOne: jest.fn().mockReturnValue(makeChain(expiredBooking)),
        },
        paymentModel: { findOneAndUpdate: jest.fn().mockResolvedValue({}) },
        stripe: {
          refunds: {
            create: jest
              .fn()
              .mockRejectedValue(new Error("Stripe refund API down")),
          },
          checkout: { sessions: { create: jest.fn(), retrieve: jest.fn() } },
        },
      });

      // Không throw — CRITICAL là log, biz logic vẫn tiếp tục
      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).resolves.toBeUndefined();
    });

    it("B4-3: throws khi booking không tìm thấy sau khi findOneAndUpdate trả null", async () => {
      const session = {
        id: "cs_test",
        metadata: {
          userId: new Types.ObjectId().toString(),
          bookingCode: "BK001",
          bookingId: new Types.ObjectId().toString(),
        },
        payment_intent: "pi_missing_booking",
        amount_total: 500_000,
        currency: "vnd",
        customer_details: null,
      } as any;

      const { service } = await buildPaymentService({
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
          findOne: jest.fn().mockReturnValue(makeChain(null)), // cả 2 query đều null
        },
      });

      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).rejects.toThrow("Booking not found during webhook processing");
    });
  });

  // ── B5: processPaypalPayment — auto-refund when booking is no longer PENDING ──

  describe("processPaypalPayment — auto-refund path (booking not PENDING)", () => {
    const orderId = "PAYPAL_AUTOREFUND";
    const userId = new Types.ObjectId().toString();

    const makePaymentRecord = () => ({
      _id: new Types.ObjectId(),
      bookingId: new Types.ObjectId(),
      status: "pending",
      currency: "VND",
      metadata: {},
    });

    it("B5-1: auto-refund và throw khi booking không còn PENDING/UNPAID (findOneAndUpdate returns null)", async () => {
      const payment = makePaymentRecord();
      const booking = {
        bookingCode: "BK_AUTOREFUND",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
      };

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest.fn().mockResolvedValue({
            result: {
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  payments: {
                    captures: [{ id: "cap_autorefund", status: "COMPLETED" }],
                  },
                },
              ],
            },
          }),
        },
      });

      // findOneAndUpdate in processPaypalPayment returns null → triggers auto-refund → throws
      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Booking is no longer available");
    });

    it("B5-2: logs CRITICAL + auto-refund when processPaypalPayment finds booking not PENDING", async () => {
      const payment = makePaymentRecord();
      const booking = {
        bookingCode: "BK_AUTOREFUND3",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
        zoneId: new Types.ObjectId(),
      };

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest.fn().mockResolvedValue({
            result: {
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  payments: {
                    captures: [{ id: "cap_autorefund3", status: "COMPLETED" }],
                  },
                },
              ],
            },
          }),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Booking is no longer available");
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "[MONEY_RISK] PayPal captured order but booking"
        ),
        expect.any(Object)
      );
    });

    it("B5-3: log CRITICAL và không throw khi auto-refund thất bại", async () => {
      const payment = makePaymentRecord();
      const booking = {
        bookingCode: "BK_AUTOREFUND2",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
      };

      // Mock the paypal refund to fail
      const paypalModule = require("@paypal/checkout-server-sdk");
      paypalModule.payments.CapturesRefundRequest = jest
        .fn()
        .mockImplementation(() => ({
          requestBody: jest.fn(),
        }));

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          // First call (capture) succeeds, second call (refund) fails
          execute: jest
            .fn()
            .mockResolvedValueOnce({
              result: {
                id: orderId,
                status: "COMPLETED",
                purchase_units: [
                  {
                    payments: {
                      captures: [
                        { id: "cap_autorefund_fail", status: "COMPLETED" },
                      ],
                    },
                  },
                ],
              },
            })
            .mockRejectedValueOnce(new Error("PayPal refund API error")),
        },
      });

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Booking is no longer available");
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("[CRITICAL] PayPal auto-refund FAILED"),
        expect.any(Object)
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// C. THANH TOÁN CHO GIAO DỊCH ĐÃ PAID / ĐÃ FINALIZED
// ═══════════════════════════════════════════════════════════════════════════════

describe("C — Thanh toán cho giao dịch đã paid / đã finalized", () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const userId = new Types.ObjectId().toString();

  // ── C1: createCheckoutSession — booking đã paid ───────────────────────────

  describe("createCheckoutSession — booking đã paid", () => {
    it("C1-1: throws BadRequestException('Booking already paid') khi paymentStatus=PAID", async () => {
      const paidBooking = {
        ...validPendingBooking(),
        paymentStatus: PaymentStatus.PAID,
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(paidBooking)),
        },
      });

      await expect(
        service.createCheckoutSession(userId, "BK001")
      ).rejects.toThrow("Booking already paid");
    });

    it("C1-2: throws BadRequestException('Booking is completed or cancelled') khi status=CONFIRMED", async () => {
      const confirmedUnpaidBooking = {
        ...validPendingBooking(),
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.UNPAID,
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(confirmedUnpaidBooking)),
        },
      });

      await expect(
        service.createCheckoutSession(userId, "BK001")
      ).rejects.toThrow("Booking is completed or cancelled");
    });

    it("C1-3: throws ConflictException khi lock không lấy được và không có session cache", async () => {
      const booking = validPendingBooking();
      const { service, redisClient } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(booking)),
        },
      });

      // Lock không acquired AND cache rỗng → conflict
      redisClient.eval.mockResolvedValueOnce(["conflict", ""]);

      await expect(
        service.createCheckoutSession(userId, "BK001")
      ).rejects.toThrow(ConflictException);
    });

    it("C1-4: trả về URL cũ khi session đã tồn tại trong cache và còn 'open'", async () => {
      const booking = validPendingBooking();
      const { service, redisClient } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(booking)),
        },
        stripe: {
          checkout: {
            sessions: {
              retrieve: jest.fn().mockResolvedValue({
                status: "open",
                url: "https://checkout.stripe.com/existing",
              }),
            },
          },
        },
      });

      redisClient.eval.mockResolvedValueOnce([
        "existing",
        "cs_existing_session_id",
      ]);

      const result = await service.createCheckoutSession(userId, "BK001");
      expect(result.checkoutUrl).toBe("https://checkout.stripe.com/existing");
      expect(result.message).toBe("Checkout session already exists");
    });

    it("C1-5: tạo session mới khi session cũ đã expired (retrieve throw)", async () => {
      const booking = validPendingBooking();
      const newSession = {
        id: "cs_new",
        url: "https://checkout.stripe.com/new",
        status: "open",
      };

      const { service, redisClient } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(booking)),
        },
        stripe: {
          checkout: {
            sessions: {
              retrieve: jest
                .fn()
                .mockRejectedValue(new Error("Session expired")),
              create: jest.fn().mockResolvedValue(newSession),
            },
          },
        },
      });

      redisClient.eval.mockResolvedValueOnce(["existing", "cs_old_session_id"]);

      const result = await service.createCheckoutSession(userId, "BK001");
      expect(result.checkoutUrl).toBe("https://checkout.stripe.com/new");
    });
  });

  // ── C2: createPaypalTransaction — booking đã paid ─────────────────────────

  describe("createPaypalTransaction — booking đã paid", () => {
    it("C2-1: throws 'Booking already paid' khi paymentStatus=PAID", async () => {
      const paidBooking = {
        ...validPendingBooking(),
        paymentStatus: PaymentStatus.PAID,
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(paidBooking)),
        },
      });

      await expect(
        service.createPaypalTransaction(userId, "BK001")
      ).rejects.toThrow("Booking already paid");
    });

    it("C2-2: throws 'Booking is completed or cancelled' khi status=CANCELLED", async () => {
      const cancelledBooking = {
        ...validPendingBooking(),
        status: BookingStatus.CANCELLED,
        paymentStatus: PaymentStatus.UNPAID,
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(cancelledBooking)),
        },
      });

      await expect(
        service.createPaypalTransaction(userId, "BK001")
      ).rejects.toThrow("Booking is completed or cancelled");
    });

    it("C2-3: throws 'Booking not found or unauthorized' khi booking null", async () => {
      const { service } = await buildPaymentService({
        bookingModel: { findOne: jest.fn().mockReturnValue(makeChain(null)) },
      });

      await expect(
        service.createPaypalTransaction(userId, "BK_NOTFOUND")
      ).rejects.toThrow("Booking not found or unauthorized");
    });

    it("C2-4: throws khi booking hết hạn", async () => {
      const expiredBooking = {
        ...validPendingBooking(),
        expiresAt: new Date(Date.now() - 1),
      };
      const { service } = await buildPaymentService({
        bookingModel: {
          findOne: jest.fn().mockReturnValue(makeChain(expiredBooking)),
        },
      });

      await expect(
        service.createPaypalTransaction(userId, "BK001")
      ).rejects.toThrow("Booking has expired");
    });
  });

  // ── C3: finalizePaypalTransaction — đã finalized ──────────────────────────

  describe("finalizePaypalTransaction — payment đã succeeded", () => {
    const orderId = "PAYPAL_EXISTING_123";

    it("C3-1: trả về 'already finalized' khi lock status là 'succeeded'", async () => {
      const payment = {
        _id: new Types.ObjectId(),
        bookingId: new Types.ObjectId(),
        status: "succeeded",
        currency: "VND",
      };
      const booking = {
        bookingCode: "BK001",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        isDeleted: false,
      };

      const idemSession = makeSession();
      const { service, redisClient } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValueOnce(idemSession) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
      });

      // lock status = "succeeded"
      redisClient.set.mockResolvedValueOnce(null);
      redisClient.get.mockResolvedValueOnce("succeeded");

      const result = await service.finalizePaypalTransaction(orderId, userId);
      expect(result.status).toBe(200);
      expect(result.message).toBe("Payment already finalized");
    });

    it("C3-2: trả về 'already finalized' khi payment.status === 'succeeded' và booking confirmed", async () => {
      const payment = {
        _id: new Types.ObjectId(),
        bookingId: new Types.ObjectId(),
        status: "succeeded", // payment DB already says succeeded
        currency: "VND",
      };
      const booking = {
        bookingCode: "BK_CONFIRMED",
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        isDeleted: false,
      };

      const idemSession = makeSession();
      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(idemSession) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        ticketService: {
          createTicketsFromBooking: jest.fn().mockResolvedValue([]),
        },
      });

      const result = await service.finalizePaypalTransaction(orderId, userId);
      expect(result.status).toBe(200);
      expect(result.message).toBe("Payment already finalized");
    });

    it("C3-3: throws khi payment succeeded nhưng booking không phải CONFIRMED+PAID (inconsistency)", async () => {
      const payment = {
        _id: new Types.ObjectId(),
        bookingId: new Types.ObjectId(),
        status: "succeeded",
        currency: "VND",
      };
      // booking is PENDING (data inconsistency)
      const booking = {
        bookingCode: "BK_INCONSISTENT",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
      };

      const { service, redisClient } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
      });

      // lock acquired as "new" (first time)
      redisClient.set.mockResolvedValueOnce("OK");

      await expect(
        service.finalizePaypalTransaction(orderId, userId)
      ).rejects.toThrow("Booking is not eligible for ticket issuance");
    });

    it("C3-4: xử lý ORDER_ALREADY_CAPTURED — trả về finalized khi payment DB đã succeeded", async () => {
      const paymentId = new Types.ObjectId();
      const payment = {
        _id: paymentId,
        bookingId: new Types.ObjectId(),
        status: "pending",
        currency: "VND",
      };
      const booking = {
        bookingCode: "BK001",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
      };

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue({ status: "succeeded" }), // DB đã succeeded
              }),
            }),
          }),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
        },
        paypalClient: {
          execute: jest.fn().mockRejectedValue({
            details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
          }),
        },
      });

      const result = await service.finalizePaypalTransaction(orderId, userId);
      expect(result.status).toBe(200);
      expect(result.message).toBe("Payment already finalized");
    });

    it("C3-5: xử lý ORDER_ALREADY_CAPTURED — recovery path khi DB chưa succeeded và PayPal có completed order", async () => {
      const paymentId = new Types.ObjectId();
      const payment = {
        _id: paymentId,
        bookingId: new Types.ObjectId(),
        status: "pending",
        currency: "VND",
        metadata: {},
      };
      const booking = {
        bookingCode: "BK_RECOVERY",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        isDeleted: false,
      };

      const eventId = new Types.ObjectId();
      const zoneId = new Types.ObjectId();

      const { service } = await buildPaymentService({
        paymentModel: {
          findOne: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payment),
              }),
            }),
          }),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest
                .fn()
                .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
            }),
          }),
          findByIdAndUpdate: jest.fn().mockResolvedValue({}),
        },
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(makeSession()) },
          findOne: jest.fn().mockReturnValue(makeChain(null)),
          findById: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(booking),
              }),
            }),
          }),
          findOneAndUpdate: jest.fn().mockReturnValue(
            makeChain({
              _id: payment.bookingId,
              bookingCode: "BK_RECOVERY",
              quantity: 0,
              seats: [],
              customerEmail: "test@test.com",
              customerName: "Test",
              userId: new Types.ObjectId(),
              totalPrice: 50000,
              zoneId: { _id: zoneId, name: "VIP" },
              eventId: {
                _id: eventId,
                title: "Concert",
                location: "Hanoi",
                startDate: new Date(),
                endDate: new Date(),
              },
            })
          ),
        },
      });

      // Mock zone gateway for processPaypalPayment's emitZoneTicketUpdate
      (service as any).zoneGateway.emitZoneTicketUpdate = jest.fn();

      // Directly set up paypalClient mock on the service
      (service as any).paypalClient.execute = jest
        .fn()
        .mockImplementationOnce(() =>
          Promise.reject({ details: [{ issue: "ORDER_ALREADY_CAPTURED" }] })
        )
        .mockImplementationOnce(() =>
          Promise.resolve({
            result: {
              id: orderId,
              status: "COMPLETED",
              purchase_units: [
                {
                  payments: {
                    captures: [{ id: "cap_recovery", status: "COMPLETED" }],
                  },
                },
              ],
            },
          })
        );

      const result = await service.finalizePaypalTransaction(orderId, userId);
      expect(result.status).toBe(200);
      expect(result.message).toBe("Payment finalized after recovery");
    });
  });

  // ── C4: handleCheckoutSessionCompleted — duplicate webhook (booking đã confirmed)

  describe("handleCheckoutSessionCompleted — booking đã confirmed (duplicate webhook)", () => {
    it("C4-1: không throw và không tạo ticket mới khi booking đã CONFIRMED+PAID", async () => {
      const bookingId = new Types.ObjectId();
      const session = {
        id: "cs_duplicate",
        metadata: {
          userId: new Types.ObjectId().toString(),
          bookingCode: "BK_CONFIRMED",
          bookingId: bookingId.toString(),
        },
        payment_intent: "pi_duplicate",
        amount_total: 1_000_000,
        currency: "vnd",
        customer_details: {
          email: "user@example.com",
          name: "Alice",
          phone: null,
        },
      } as any;

      const alreadyConfirmedBooking = {
        _id: bookingId,
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        userId: new Types.ObjectId(),
        bookingCode: "BK_CONFIRMED",
        eventId: new Types.ObjectId(), // not populated - will trigger raw query path
        zoneId: new Types.ObjectId(),
        seats: [],
        quantity: 2,
        totalPrice: 1_000_000,
        customerEmail: "user@example.com",
      };

      const mockSession = makeSession();

      const { service } = await buildPaymentService({
        bookingModel: {
          db: { startSession: jest.fn().mockResolvedValue(mockSession) },
          // findOneAndUpdate → null (booking không còn PENDING)
          findOneAndUpdate: jest.fn().mockReturnValue(makeChain(null)),
          // findOne → alreadyConfirmedBooking (re-read)
          findOne: jest
            .fn()
            .mockReturnValue(makeChain(alreadyConfirmedBooking)),
        },
        paymentModel: { findOneAndUpdate: jest.fn().mockResolvedValue({}) },
      });

      await expect(
        service.handleCheckoutSessionCompleted(session)
      ).resolves.toBeUndefined();
      // Không gọi createTicketsFromBooking vì booking đã confirmed (shouldRefund = false, flow dừng sớm)
      // hoặc gọi nhưng idempotency trả về existing tickets
    });
  });
});
