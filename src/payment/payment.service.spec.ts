import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import {
  BadRequestException,
  ConflictException,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { Types } from "mongoose";
import Stripe from "stripe";

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
import { ZoneService } from "@src/zone/zone.service";
import { UserEventsService } from "@src/events/user-event.services";
import { QueueService } from "@src/queue/queue.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { CurrencyService } from "@src/currency/currency.service";
import { paymentTestProviders } from "./testing/payment-test.providers";
import { PaymentGatewayService } from "./infrastructure/gateway/payment-gateway.service";
import { PaymentIdempotencyService } from "./infrastructure/idempotency/payment-idempotency.service";
import { IssueAdminRefundUseCase } from "./application/use-case/issue-admin-refund.use-case";
import { toPaymentObjectId } from "./domain/utils/payment-document.utils";
import { PromotionService } from "@src/promotion/promotion.service";

jest.mock("stripe", () => jest.fn().mockImplementation(() => ({})));

jest.mock("@paypal/checkout-server-sdk", () => ({
  core: {
    SandboxEnvironment: jest.fn(),
    LiveEnvironment: jest.fn(),
    PayPalHttpClient: jest
      .fn()
      .mockImplementation(() => ({ execute: jest.fn() })),
  },
  orders: {
    OrdersCreateRequest: jest.fn().mockImplementation(() => ({
      prefer: jest.fn(),
      requestBody: jest.fn(),
    })),
    OrdersCaptureRequest: jest
      .fn()
      .mockImplementation(() => ({ requestBody: jest.fn() })),
    OrdersGetRequest: jest.fn().mockImplementation(() => ({})),
  },
  payments: {
    CapturesRefundRequest: jest.fn().mockImplementation(() => ({
      requestBody: jest.fn(),
      payPalRequestId: jest.fn().mockReturnThis(),
    })),
  },
}));

jest.mock("@src/config/config", () => ({
  default: {
    STRIPE_SECRET_KEY: "sk_test_fake",
    PAYPAL_CLIENT_ID: "fake_paypal_id",
    PAYPAL_CLIENT_SECRET: "fake_paypal_secret",
    FRONTEND_URL: "http://localhost:3000",
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PAYMENT_INTENT_ID = "pi_test_stripe_123";

const makeCharge = (overrides: Record<string, unknown> = {}): Stripe.Charge =>
  ({
    payment_intent: PAYMENT_INTENT_ID,
    refunded: true,
    amount: 10000,
    amount_refunded: 10000,
    ...overrides,
  }) as unknown as Stripe.Charge;

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("PaymentService – handleChargeRefunded", () => {
  let service: PaymentService;
  let bookingModel: any;
  let ticketModel: any;
  let zoneModel: any;
  let paymentModel: any;
  let zoneGateway: any;
  let zoneService: any;
  let mockSession: any;
  let promotionService: { releaseUsageForBooking: jest.Mock };

  const bookingId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();

  const makeBooking = (overrides: Record<string, unknown> = {}) => ({
    _id: bookingId,
    stripePaymentIntentId: PAYMENT_INTENT_ID,
    paymentStatus: "paid",
    status: "confirmed",
    isDeleted: false,
    quantity: 2,
    zoneId,
    cancelledAt: null as Date | null,
    cancellationReason: null as string | null,
    totalRefunded: 0,
    refundHistory: [] as Array<{ amount: number; refundedAt: Date }>,
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  beforeEach(async () => {
    mockSession = {
      withTransaction: jest
        .fn()
        .mockImplementation(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    bookingModel = {
      db: { startSession: jest.fn().mockResolvedValue(mockSession) },
      findOne: jest.fn(),
    };

    ticketModel = {
      updateMany: jest.fn().mockResolvedValue({ modifiedCount: 2 }),
    };

    zoneModel = {
      findByIdAndUpdate: jest.fn().mockResolvedValue(null),
      updateOne: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      }),
    };

    paymentModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue(null),
    };

    zoneGateway = { emitZoneTicketUpdate: jest.fn() };
    zoneService = {
      invalidateZoneAvailabilityCache: jest.fn().mockResolvedValue(undefined),
    };
    promotionService = {
      releaseUsageForBooking: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        {
          provide: RedisService,
          useValue: {
            client: {
              get: jest.fn().mockResolvedValue(null),
              set: jest.fn().mockResolvedValue("OK"),
              del: jest.fn().mockResolvedValue(1),
              eval: jest.fn().mockResolvedValue(1),
              sMembers: jest.fn().mockResolvedValue([]),
              sAdd: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
          },
        },
        { provide: ZoneGateway, useValue: zoneGateway },
        { provide: ZoneService, useValue: zoneService },
        { provide: UserEventsService, useValue: {} },
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
            zoneLockContentionTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        {
          provide: CurrencyService,
          useValue: { getVndPerUsd: jest.fn().mockResolvedValue(26000) },
        },
        { provide: PromotionService, useValue: promotionService },
      ],
    }).compile();

    service = module.get<PaymentService>(PaymentService);
  });

  afterEach(() => jest.restoreAllMocks());

  // ── Guard clauses ──────────────────────────────────────────────────────────

  describe("guard clauses — early-return before any DB work", () => {
    it("does nothing when payment_intent is null", async () => {
      await service.handleChargeRefunded(makeCharge({ payment_intent: null }));
      expect(bookingModel.db.startSession).not.toHaveBeenCalled();
    });

    it("does nothing when amount_refunded is 0 (no refund occurred)", async () => {
      await service.handleChargeRefunded(
        makeCharge({ refunded: false, amount_refunded: 0 })
      );
      expect(bookingModel.db.startSession).not.toHaveBeenCalled();
    });
  });

  // ── No matching booking ────────────────────────────────────────────────────

  describe("no matching booking (already refunded or wrong state)", () => {
    beforeEach(() => {
      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      });
    });

    it("does NOT call ticketModel.updateMany when booking is not found", async () => {
      await service.handleChargeRefunded(makeCharge());
      expect(ticketModel.updateMany).not.toHaveBeenCalled();
    });

    it("still ends the DB session in the finally block", async () => {
      await service.handleChargeRefunded(makeCharge());
      expect(mockSession.endSession).toHaveBeenCalledTimes(1);
    });
  });

  // ── Happy path: fraud prevention (the core fix) ────────────────────────────

  describe("successful refund — tickets must be cancelled to prevent fraud check-in", () => {
    let booking: ReturnType<typeof makeBooking>;

    beforeEach(() => {
      booking = makeBooking();
      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(booking),
      });
    });

    it("calls ticketModel.updateMany targeting only valid tickets of this booking", async () => {
      await service.handleChargeRefunded(makeCharge());

      expect(ticketModel.updateMany).toHaveBeenCalledWith(
        { bookingId: booking._id, status: "valid", isDeleted: false },
        { $set: { status: "cancelled", cancelledAt: expect.any(Date) } },
        { session: mockSession }
      );
    });

    it("passes the active MongoDB session to updateMany (atomicity with booking.save)", async () => {
      await service.handleChargeRefunded(makeCharge());

      const [, , opts] = ticketModel.updateMany.mock.calls[0] as [
        unknown,
        unknown,
        { session: unknown },
      ];
      // The session object must be the exact same reference — same transaction
      expect(opts.session).toBe(mockSession);
    });

    it("invalidates the zone availability cache after a full refund releases inventory (PRE-7)", async () => {
      await service.handleChargeRefunded(makeCharge());

      expect(zoneService.invalidateZoneAvailabilityCache).toHaveBeenCalledWith(
        zoneId
      );
    });

    it("calls updateMany AFTER booking.save (correct operation order in transaction)", async () => {
      const callOrder: string[] = [];
      booking.save.mockImplementation(async () => {
        callOrder.push("booking.save");
      });
      ticketModel.updateMany.mockImplementation(async () => {
        callOrder.push("ticketModel.updateMany");
        return { modifiedCount: 2 };
      });

      await service.handleChargeRefunded(makeCharge());

      expect(callOrder).toEqual(["booking.save", "ticketModel.updateMany"]);
    });

    it("sets booking.status to 'cancelled' and paymentStatus to 'refunded'", async () => {
      await service.handleChargeRefunded(makeCharge());

      expect(booking.status).toBe("cancelled");
      expect(booking.paymentStatus).toBe("refunded");
      expect(booking.cancellationReason).toBe("Refunded via Stripe");
    });

    it("decrements zone soldCount with $max floor guard inside the same transaction", async () => {
      await service.handleChargeRefunded(makeCharge());

      expect(zoneModel.updateOne).toHaveBeenCalledWith(
        { _id: zoneId },
        [
          {
            $set: {
              soldCount: {
                $max: [{ $subtract: ["$soldCount", booking.quantity] }, 0],
              },
            },
          },
        ],
        { session: mockSession }
      );
    });

    it("updates payment record to refunded status inside the transaction", async () => {
      await service.handleChargeRefunded(makeCharge());

      expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
        { stripePaymentIntentId: PAYMENT_INTENT_ID, isDeleted: false },
        expect.objectContaining({
          status: "refunded",
          refundedAt: expect.any(Date),
        }),
        { session: mockSession }
      );
    });

    it("ends the DB session exactly once in the finally block", async () => {
      await service.handleChargeRefunded(makeCharge());
      expect(mockSession.endSession).toHaveBeenCalledTimes(1);
    });

    it("releases the booking's promo usage in the same transaction on a full refund (#3 promo quota leak)", async () => {
      await service.handleChargeRefunded(makeCharge());

      expect(promotionService.releaseUsageForBooking).toHaveBeenCalledWith(
        booking._id,
        mockSession
      );
    });

    it("aborts the transaction (rejects) when releasing promo usage fails, instead of committing a cancelled booking with dangling promo quota", async () => {
      promotionService.releaseUsageForBooking.mockRejectedValueOnce(
        new Error("promotion usage write conflict")
      );

      await expect(service.handleChargeRefunded(makeCharge())).rejects.toThrow(
        "promotion usage write conflict"
      );
    });
  });

  // ── Zero-quantity booking ──────────────────────────────────────────────────

  describe("zero-quantity booking edge case", () => {
    it("still cancels tickets even when booking.quantity is 0", async () => {
      const booking = makeBooking({ quantity: 0 });
      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(booking),
      });

      await service.handleChargeRefunded(makeCharge());

      expect(ticketModel.updateMany).toHaveBeenCalledWith(
        { bookingId: booking._id, status: "valid", isDeleted: false },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "cancelled" }),
        }),
        { session: mockSession }
      );
    });

    it("skips zone soldCount decrement when quantity is 0", async () => {
      const booking = makeBooking({ quantity: 0 });
      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(booking),
      });

      await service.handleChargeRefunded(makeCharge());

      expect(zoneModel.updateOne).not.toHaveBeenCalled();
    });
  });

  // ── Partial refund ──────────────────────────────────────────────────────────

  describe("partial refund — booking stays CONFIRMED, tickets remain valid", () => {
    let booking: ReturnType<typeof makeBooking>;

    const partialCharge = () =>
      makeCharge({ amount: 20000, amount_refunded: 10000 });

    beforeEach(() => {
      booking = makeBooking();
      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(booking),
      });
    });

    it("does NOT cancel the booking", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(booking.status).toBe("confirmed");
      expect(booking.paymentStatus).toBe("paid");
    });

    it("does NOT cancel tickets", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(ticketModel.updateMany).not.toHaveBeenCalled();
    });

    it("does NOT decrement zone soldCount", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(zoneModel.updateOne).not.toHaveBeenCalled();
    });

    it("updates booking refund metadata", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(booking.totalRefunded).toBe(100);
      expect(booking.refundHistory).toHaveLength(1);
      expect(booking.refundHistory[0].amount).toBe(100);
      expect(booking.refundHistory[0].refundedAt).toBeInstanceOf(Date);
    });

    it("updates payment record with partially_refunded status", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
        { stripePaymentIntentId: PAYMENT_INTENT_ID, isDeleted: false },
        expect.objectContaining({
          status: "partially_refunded",
          refundAmount: 100,
        }),
        { session: mockSession }
      );
    });

    it("ends the DB session exactly once", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(mockSession.endSession).toHaveBeenCalledTimes(1);
    });

    it("does NOT release promo usage on a partial refund (booking/ticket still valid)", async () => {
      await service.handleChargeRefunded(partialCharge());

      expect(promotionService.releaseUsageForBooking).not.toHaveBeenCalled();
    });
  });
});

// ─── PayPal already-captured detection ───────────────────────────────────────
// Verifies the fix for the fragile 422-only detection that caused false positives.
describe("PaymentGatewayService – isPaypalAlreadyCapturedError", () => {
  let service: PaymentGatewayService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        { provide: getModelToken(Booking.name), useValue: {} },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        {
          provide: RedisService,
          useValue: {
            client: {
              set: jest.fn().mockResolvedValue("OK"),
              get: jest.fn().mockResolvedValue(null),
              del: jest.fn().mockResolvedValue(1),
              eval: jest.fn().mockResolvedValue(1),
              sMembers: jest.fn().mockResolvedValue([]),
              sAdd: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
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
            zoneLockContentionTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        {
          provide: CurrencyService,
          useValue: { getVndPerUsd: jest.fn().mockResolvedValue(26000) },
        },
      ],
    }).compile();
    service = module.get(PaymentGatewayService);
  });

  it("returns true when details[0].issue === ORDER_ALREADY_CAPTURED", () => {
    const err = {
      statusCode: 422,
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "ORDER_ALREADY_CAPTURED" }],
    };
    expect(service.isPaypalAlreadyCapturedError(err)).toBe(true);
  });

  it("returns true when message contains ORDER_ALREADY_CAPTURED (legacy fallback)", () => {
    const err = { message: "Order already captured: ORDER_ALREADY_CAPTURED" };
    expect(service.isPaypalAlreadyCapturedError(err)).toBe(true);
  });

  it("returns false for bare 422 with a different issue (expired order)", () => {
    const err = {
      statusCode: 422,
      name: "UNPROCESSABLE_ENTITY",
      details: [{ issue: "ORDER_ALREADY_VOIDED" }],
    };
    expect(service.isPaypalAlreadyCapturedError(err)).toBe(false);
  });

  it("returns false for 422 with no details (invalid amount, etc.)", () => {
    const err = {
      statusCode: 422,
      name: "UNPROCESSABLE_ENTITY",
      message: "Invalid amount.",
    };
    expect(service.isPaypalAlreadyCapturedError(err)).toBe(false);
  });

  it("returns false for null", () => {
    expect(service.isPaypalAlreadyCapturedError(null)).toBe(false);
  });

  it("returns false for a network error (not a PayPal structured error)", () => {
    expect(service.isPaypalAlreadyCapturedError(new Error("ECONNRESET"))).toBe(
      false
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Webhook idempotency helpers
// ─────────────────────────────────────────────────────────────────────────────
describe("PaymentService – webhook idempotency", () => {
  let service: PaymentService;
  let redisClient: any;

  const makeRedis = (overrides: Partial<typeof redisClient> = {}) => ({
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
    eval: jest.fn().mockResolvedValue(1),
    sMembers: jest.fn().mockResolvedValue([]),
    sAdd: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    ...overrides,
  });

  const buildService = async (redisMock = makeRedis()) => {
    redisClient = redisMock;
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        {
          provide: getModelToken(Booking.name),
          useValue: { db: { startSession: jest.fn() } },
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: RedisService, useValue: { client: redisMock } },
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
    return module.get<PaymentService>(PaymentService);
  };

  beforeEach(async () => {
    service = await buildService();
  });

  describe("acquireWebhookIdempotency", () => {
    it("returns 'new' when lock is acquired (SET NX succeeds)", async () => {
      redisClient.set.mockResolvedValueOnce("OK");
      const status = await service.acquireWebhookIdempotency("evt_123");
      expect(status).toBe("new");
    });

    it("returns 'succeeded' when key already has value 'succeeded'", async () => {
      redisClient.set.mockResolvedValueOnce(null); // NX fails
      redisClient.get.mockResolvedValueOnce("succeeded");
      const status = await service.acquireWebhookIdempotency("evt_123");
      expect(status).toBe("succeeded");
    });

    it("returns 'processing' when key has value 'processing'", async () => {
      redisClient.set.mockResolvedValueOnce(null);
      redisClient.get.mockResolvedValueOnce("processing");
      const status = await service.acquireWebhookIdempotency("evt_123");
      expect(status).toBe("processing");
    });

    it("throws BadRequestException when eventId is empty", async () => {
      await expect(service.acquireWebhookIdempotency("")).rejects.toThrow();
    });

    it("throws ServiceUnavailableException when Redis is unavailable", async () => {
      redisClient.set.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      await expect(
        service.acquireWebhookIdempotency("evt_123")
      ).rejects.toThrow();
    });
  });

  describe("markWebhookSucceeded", () => {
    it("sets the idempotency key to 'succeeded' with 24h TTL", async () => {
      await service.markWebhookSucceeded("evt_abc");
      expect(redisClient.set).toHaveBeenCalledWith(
        "idemp:payment:evt_abc",
        "succeeded",
        expect.objectContaining({ EX: 24 * 60 * 60 })
      );
    });
  });

  describe("releaseWebhookProcessing", () => {
    it("runs the Lua release script with 'processing' as the expected value", async () => {
      await service.releaseWebhookProcessing("evt_xyz");
      expect(redisClient.eval).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          keys: ["idemp:payment:evt_xyz"],
          arguments: ["processing"],
        })
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handlePaymentCancelled
// ─────────────────────────────────────────────────────────────────────────────
describe("PaymentService – handlePaymentCancelled", () => {
  let service: PaymentService;
  let bookingModel: any;
  let zoneModel: any;
  let mockSession: any;
  let zoneGateway: any;

  const userId = new Types.ObjectId().toString();
  const zoneId = new Types.ObjectId();

  beforeEach(async () => {
    mockSession = {
      withTransaction: jest.fn().mockImplementation(async (fn: any) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const cancelledBooking = {
      zoneId,
      quantity: 2,
    };

    bookingModel = {
      db: { startSession: jest.fn().mockResolvedValue(mockSession) },
      findOneAndUpdate: jest.fn().mockResolvedValue(cancelledBooking),
    };

    zoneModel = {
      updateOne: jest.fn().mockResolvedValue({}),
      findById: jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      }),
    };

    zoneGateway = { emitZoneTicketUpdate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: zoneGateway },
        { provide: UserEventsService, useValue: {} },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              get: jest.fn().mockResolvedValue(null),
              set: jest.fn().mockResolvedValue("OK"),
              del: jest.fn().mockResolvedValue(1),
              eval: jest.fn().mockResolvedValue(1),
            },
          },
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
    service = module.get(PaymentService);
  });

  it("cancels a pending unpaid booking and decrements soldCount", async () => {
    const result = await service.handlePaymentCancelled(userId, "BK001");
    expect(bookingModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ bookingCode: "BK001" }),
      expect.any(Object),
      expect.any(Object)
    );
    expect(zoneModel.updateOne).toHaveBeenCalled();
    expect(result?.status).toBe(200);
  });

  it("returns undefined (no-op) when booking is not found in PENDING/UNPAID state", async () => {
    bookingModel.findOneAndUpdate.mockResolvedValueOnce(null);
    const result = await service.handlePaymentCancelled(userId, "BK_NOT_FOUND");
    expect(result).toBeUndefined();
    expect(zoneModel.updateOne).not.toHaveBeenCalled();
  });

  it("normalizes booking code to uppercase", async () => {
    await service.handlePaymentCancelled(userId, "bk001");
    expect(bookingModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ bookingCode: "BK001" }),
      expect.any(Object),
      expect.any(Object)
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// handlePaymentIntentFailed + handlePaymentIntentCanceled
// ─────────────────────────────────────────────────────────────────────────────
describe("PaymentService – payment intent event handlers", () => {
  let service: any;
  let paymentModel: any;
  let bookingModel: any;

  beforeEach(async () => {
    paymentModel = {
      updateOne: jest.fn().mockResolvedValue({}),
      findOne: jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
    };
    bookingModel = {
      db: { startSession: jest.fn() },
      findOne: jest
        .fn()
        .mockReturnValue({ select: jest.fn().mockResolvedValue(null) }),
      updateOne: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              get: jest.fn(),
              set: jest.fn(),
              del: jest.fn(),
              eval: jest.fn(),
            },
          },
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
    service = module.get(PaymentService);
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe("handlePaymentIntentFailed", () => {
    it("updates payment record status to failed", async () => {
      const pi = {
        id: "pi_test_123",
        last_payment_error: { message: "card declined" },
      } as any;
      await service.handlePaymentIntentFailed(pi);
      expect(paymentModel.updateOne).toHaveBeenCalledWith(
        { stripePaymentIntentId: "pi_test_123", isDeleted: false },
        expect.objectContaining({
          $set: expect.objectContaining({ status: "failed" }),
        })
      );
    });

    it("does not throw when DB update fails", async () => {
      paymentModel.updateOne.mockRejectedValueOnce(new Error("DB error"));
      const pi = { id: "pi_xyz", last_payment_error: null } as any;
      await expect(
        service.handlePaymentIntentFailed(pi)
      ).resolves.toBeUndefined();
    });
  });

  describe("handlePaymentIntentCanceled", () => {
    it("returns without action when no booking found", async () => {
      const pi = { id: "pi_cancelled_123" } as any;
      await expect(
        service.handlePaymentIntentCanceled(pi)
      ).resolves.toBeUndefined();
      expect(Logger.prototype.error).not.toHaveBeenCalled();
    });

    it("logs ALERT when booking is CONFIRMED but PI is cancelled", async () => {
      bookingModel.findOne.mockReturnValue({
        select: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(),
          bookingCode: "BK_ALERT",
          status: "confirmed",
          paymentStatus: "paid",
        }),
      });
      const pi = { id: "pi_cancelled_confirmed" } as any;
      await service.handlePaymentIntentCanceled(pi);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("ALERT")
      );
    });
  });

  describe("handlePaymentIntentSucceeded", () => {
    it("logs debug message", () => {
      jest.spyOn(Logger.prototype, "debug").mockImplementation(() => {});
      const pi = { id: "pi_success_123" } as any;
      service.handlePaymentIntentSucceeded(pi);
      expect(Logger.prototype.debug).toHaveBeenCalledWith(
        "payment_intent.succeeded received: pi_success_123"
      );
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withPaypalTimeout — unit test of the timeout helper
// ─────────────────────────────────────────────────────────────────────────────
describe("PaymentService – withPaypalTimeout", () => {
  let service: any;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        {
          provide: getModelToken(Booking.name),
          useValue: { db: { startSession: jest.fn() } },
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        {
          provide: QueueService,
          useValue: { addJob: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              get: jest.fn(),
              set: jest.fn(),
              del: jest.fn(),
              eval: jest.fn(),
            },
          },
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
    service = module.get(PaymentGatewayService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("resolves when the promise completes before timeout", async () => {
    const fast = Promise.resolve({ result: "ok" });
    const result = await service.withPaypalTimeout(fast);
    expect(result).toEqual({ result: "ok" });
  });

  it("rejects with timeout error when promise takes too long", async () => {
    jest.spyOn(global, "setTimeout").mockImplementation((callback: any) => {
      callback();
      return { unref: jest.fn() } as unknown as NodeJS.Timeout;
    });
    const slow = new Promise(() => undefined);
    const p = service.withPaypalTimeout(slow);

    await expect(p).rejects.toThrow("PayPal request timed out");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// toObjectId — all branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – toObjectId", () => {
  it("returns ObjectId as-is when input is already a Types.ObjectId", () => {
    const id = new Types.ObjectId();
    expect(toPaymentObjectId(id, "field")).toBe(id);
  });

  it("converts a string to ObjectId", () => {
    const str = new Types.ObjectId().toString();
    const result = toPaymentObjectId(str, "field");
    expect(result).toBeInstanceOf(Types.ObjectId);
    expect(result.toString()).toBe(str);
  });

  it("extracts _id from object when _id is ObjectId", () => {
    const id = new Types.ObjectId();
    const result = toPaymentObjectId({ _id: id }, "field");
    expect(result).toBe(id);
  });

  it("converts string _id from object to ObjectId", () => {
    const str = new Types.ObjectId().toString();
    const result = toPaymentObjectId({ _id: str }, "field");
    expect(result).toBeInstanceOf(Types.ObjectId);
    expect(result.toString()).toBe(str);
  });

  it("throws BadRequestException when field is missing (undefined)", () => {
    expect(() => toPaymentObjectId(undefined, "myField")).toThrow(
      BadRequestException
    );
  });

  it("throws BadRequestException when value has no _id", () => {
    expect(() => toPaymentObjectId({}, "emptyField")).toThrow(
      BadRequestException
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// enqueueRefundFailureAlert — error branch (line 115)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – enqueueRefundFailureAlert", () => {
  let service: any;
  let queueService: any;

  beforeEach(async () => {
    queueService = {
      addJob: jest.fn().mockRejectedValue(new Error("Queue down")),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        {
          provide: getModelToken(Booking.name),
          useValue: { db: { startSession: jest.fn() } },
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: queueService },
        { provide: RedisService, useValue: { client: {} } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(IssueAdminRefundUseCase);

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("logs error and does NOT throw when queue addJob fails", async () => {
    // Invoke the private method via bracket notation
    await service.enqueueRefundFailureAlert(
      "bookingId",
      "pi_123",
      "stripe",
      "error msg"
    );

    expect(queueService.addJob).toHaveBeenCalled();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("[ALERT_ENQUEUE_FAILED]")
    );
  });

  it("increments refundFailuresTotal metric", async () => {
    const metricsService = service.metricsService;

    await service.enqueueRefundFailureAlert("b1", "pi_x", "paypal", "fail");

    expect(metricsService.refundFailuresTotal.inc).toHaveBeenCalledWith({
      source: "paypal",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// acquirePaypalLock — error branch (lines 271-274)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – acquirePaypalLock error branch", () => {
  let service: any;
  let redisClient: any;

  beforeEach(async () => {
    redisClient = {
      set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        {
          provide: getModelToken(Booking.name),
          useValue: { db: { startSession: jest.fn() } },
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        { provide: RedisService, useValue: { client: redisClient } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentIdempotencyService);

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("throws ServiceUnavailableException when Redis is unavailable", async () => {
    await expect(service.acquirePaypalLock("order_123")).rejects.toThrow(
      ServiceUnavailableException
    );
  });

  it("logs the Redis error details", async () => {
    try {
      await service.acquirePaypalLock("order_123");
    } catch {
      // expected
    }
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("PayPal lock unavailable for order order_123")
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createCheckoutSession — extended tests including success path
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – createCheckoutSession extended", () => {
  let service: any;
  let bookingModel: any;
  let redisClient: any;
  let mockStripe: any;

  const userId = new Types.ObjectId().toString();
  const bookingId = new Types.ObjectId();

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
    obj.populate.mockReturnValue(obj);
    return obj;
  };

  const makeValidBooking = () => ({
    _id: bookingId,
    bookingCode: "BK001",
    status: BookingStatus.PENDING,
    paymentStatus: PaymentStatus.UNPAID,
    // Must clear PaymentService.STRIPE_MIN_EXPIRES_IN_MS (31 min) — mirrors
    // the real BOOKING_EXPIRY_MS (40 min) so a freshly created booking is
    // valid to check out, same as in production.
    expiresAt: new Date(Date.now() + 40 * 60_000),
    quantity: 2,
    seats: [],
    pricePerTicket: 500_000,
    totalPrice: 1_000_000,
    customerEmail: "user@example.com",
    customerName: "Alice",
    customerPhone: "0901234567",
    userId: new Types.ObjectId(),
    eventId: {
      _id: new Types.ObjectId(),
      title: "Concert",
      thumbnail: null,
      location: "Hanoi",
      startDate: new Date(),
      endDate: new Date(),
    },
    zoneId: { _id: new Types.ObjectId(), name: "Zone A", price: 500_000 },
    areaId: null,
  });

  beforeEach(async () => {
    redisClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(["locked", ""]),
    };

    bookingModel = {
      findOne: jest.fn(),
      db: { startSession: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
        {
          provide: UserEventsService,
          useValue: { emitSendBookingConfirmation: jest.fn() },
        },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        { provide: RedisService, useValue: { client: redisClient } },
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
    service = module.get(PaymentService);

    mockStripe = (service as any).paymentGateway.stripe;
    mockStripe.checkout = {
      sessions: {
        create: jest.fn(),
        retrieve: jest.fn(),
      },
    };
    mockStripe.refunds = { create: jest.fn() };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("creates a Stripe checkout session successfully (happy path)", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    const stripeSession = {
      id: "cs_live_test_123",
      url: "https://checkout.stripe.com/pay/cs_live_test_123",
    };
    mockStripe.checkout.sessions.create.mockResolvedValue(stripeSession);

    const result = await service.createCheckoutSession(userId, "BK001");

    expect(mockStripe.checkout.sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "payment",
        customer_email: "user@example.com",
        metadata: expect.objectContaining({
          bookingCode: "BK001",
          userId,
          originalTotalPrice: "1000000",
          discountAmount: "0",
          promotionCode: "",
        }),
        line_items: expect.arrayContaining([
          expect.objectContaining({
            quantity: 1,
            price_data: expect.objectContaining({
              currency: "vnd",
              unit_amount: 1_000_000,
            }),
          }),
        ]),
      })
    );
    expect(result.checkoutUrl).toBe(
      "https://checkout.stripe.com/pay/cs_live_test_123"
    );
    expect(result.message).toBe("Checkout session created successfully");
  });

  it("uses the booking's snapshot (not the live-populated event/zone) for the Stripe product name when present", async () => {
    const booking = {
      ...makeValidBooking(),
      snapshot: {
        eventTitle: "Original title at booking time",
        location: "Original location",
        eventStartDate: new Date("2029-01-01"),
        eventEndDate: new Date("2029-01-02"),
        zoneName: "Original zone name",
        pricePerTicket: 500_000,
        currency: "VND",
      },
    };
    bookingModel.findOne.mockReturnValue(makeChain(booking));
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_snapshot_test",
      url: "https://checkout.stripe.com/pay/cs_snapshot_test",
    });

    await service.createCheckoutSession(userId, "BK001");

    const createCall = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(createCall.line_items[0].price_data.product_data.name).toBe(
      "Original title at booking time - Original zone name"
    );
  });

  it("falls back to the live-populated event/zone for the Stripe product name when no snapshot exists", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_fallback_test",
      url: "https://checkout.stripe.com/pay/cs_fallback_test",
    });

    await service.createCheckoutSession(userId, "BK001");

    const createCall = mockStripe.checkout.sessions.create.mock.calls[0][0];
    expect(createCall.line_items[0].price_data.product_data.name).toBe(
      "Concert - Zone A"
    );
  });

  it("stores the session ID in Redis after creation", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_stored",
      url: "https://checkout.stripe.com/pay/cs_stored",
    });

    await service.createCheckoutSession(userId, "BK001");

    expect(redisClient.set).toHaveBeenCalledWith(
      `checkout:session:${bookingId.toString()}`,
      "cs_stored",
      expect.objectContaining({ EX: expect.any(Number) })
    );
    expect(redisClient.del).toHaveBeenCalledWith(
      `checkout:lock:${bookingId.toString()}`
    );
  });

  it("returns existing session URL when session is cached and still open", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    // Existing session found via Lua script
    redisClient.eval.mockResolvedValueOnce(["existing", "cs_existing_open"]);
    mockStripe.checkout.sessions.retrieve.mockResolvedValue({
      status: "open",
      url: "https://checkout.stripe.com/pay/cs_existing",
    });

    const result = await service.createCheckoutSession(userId, "BK001");

    expect(result.message).toBe("Checkout session already exists");
    expect(result.checkoutUrl).toBe(
      "https://checkout.stripe.com/pay/cs_existing"
    );
    expect(mockStripe.checkout.sessions.create).not.toHaveBeenCalled();
  });

  it("creates a new session when cached session has expired (retrieve throws)", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    redisClient.eval.mockResolvedValueOnce(["existing", "cs_expired_session"]);
    mockStripe.checkout.sessions.retrieve.mockRejectedValue(
      new Error("expired")
    );
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_new_after_expired",
      url: "https://checkout.stripe.com/pay/new",
    });

    const result = await service.createCheckoutSession(userId, "BK001");

    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/pay/new");
    expect(mockStripe.checkout.sessions.create).toHaveBeenCalled();
  });

  it("throws ConflictException when dedup lock not acquired and no cached session", async () => {
    bookingModel.findOne.mockReturnValue(makeChain(makeValidBooking()));

    redisClient.eval.mockResolvedValueOnce(["conflict", ""]);

    await expect(
      service.createCheckoutSession(userId, "BK001")
    ).rejects.toThrow(ConflictException);
  });

  it("throws BadRequestException when booking is not found", async () => {
    bookingModel.findOne.mockReturnValue(makeChain(null));

    await expect(
      service.createCheckoutSession(userId, "BK_NOT_FOUND")
    ).rejects.toThrow("Booking not found or unauthorized");
  });

  it("throws BadRequestException when booking is already CONFIRMED", async () => {
    const booking = { ...makeValidBooking(), status: BookingStatus.CONFIRMED };
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    await expect(
      service.createCheckoutSession(userId, "BK001")
    ).rejects.toThrow("Booking is completed or cancelled");
  });

  it("throws BadRequestException when booking is already PAID", async () => {
    const booking = {
      ...makeValidBooking(),
      paymentStatus: PaymentStatus.PAID,
    };
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    await expect(
      service.createCheckoutSession(userId, "BK001")
    ).rejects.toThrow("Booking already paid");
  });

  it("throws BadRequestException when booking has expired", async () => {
    const booking = {
      ...makeValidBooking(),
      expiresAt: new Date(Date.now() - 60_000),
    };
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    await expect(
      service.createCheckoutSession(userId, "BK001")
    ).rejects.toThrow("Booking has expired");
  });

  it("uses fallback thumbnail when event thumbnail is null", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));
    mockStripe.checkout.sessions.create.mockResolvedValue({
      id: "cs_thumb",
      url: "https://checkout.stripe.com/pay/thumb",
    });

    await service.createCheckoutSession(userId, "BK001");

    const createCall = mockStripe.checkout.sessions.create.mock.calls[0][0];
    const imageUrl = createCall.line_items[0].price_data.product_data.images[0];
    expect(imageUrl).toContain("unsplash.com");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createPaypalTransaction — success path
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – createPaypalTransaction success", () => {
  let service: any;
  let bookingModel: any;
  let paymentModel: any;
  let currencyService: any;

  const userId = new Types.ObjectId().toString();
  const bookingId = new Types.ObjectId();

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
    obj.populate.mockReturnValue(obj);
    return obj;
  };

  const makeValidBooking = () => ({
    _id: bookingId,
    bookingCode: "BK_PAYPAL",
    status: BookingStatus.PENDING,
    paymentStatus: PaymentStatus.UNPAID,
    expiresAt: new Date(Date.now() + 30 * 60_000),
    quantity: 2,
    seats: [],
    pricePerTicket: 500_000,
    totalPrice: 1_000_000,
    customerEmail: "paypal@example.com",
    customerName: "Bob",
    customerPhone: "0909876543",
    userId: new Types.ObjectId(),
    eventId: {
      _id: new Types.ObjectId(),
      title: "Rock Concert",
      thumbnail: "thumb.jpg",
      location: "HCMC",
      startDate: new Date(),
      endDate: new Date(),
    },
    zoneId: { _id: new Types.ObjectId(), name: "VIP", price: 500_000 },
    areaId: null,
  });

  beforeEach(async () => {
    currencyService = { getVndPerUsd: jest.fn().mockResolvedValue(26000) };

    paymentModel = {
      findOneAndUpdate: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId() }),
    };

    bookingModel = {
      findOne: jest.fn(),
      db: { startSession: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
        {
          provide: UserEventsService,
          useValue: { emitSendBookingConfirmation: jest.fn() },
        },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        { provide: RedisService, useValue: { client: {} } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: currencyService },
      ],
    }).compile();
    service = module.get(PaymentService);

    // Set up paypalClient and SDK mocks
    (service as any).paymentGateway.paypalClient = { execute: jest.fn() };

    const paypalModule = require("@paypal/checkout-server-sdk");
    paypalModule.orders.OrdersCreateRequest = jest
      .fn()
      .mockImplementation(() => {
        const req: any = { body: {} };
        req.prefer = jest.fn();
        req.requestBody = jest.fn().mockImplementation((body: any) => {
          req.body = body;
        });
        return req;
      });
    paypalModule.orders.OrdersCaptureRequest = jest
      .fn()
      .mockImplementation(() => ({
        requestBody: jest.fn(),
      }));

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("creates PayPal order successfully and upserts payment record", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockResolvedValue({
      result: {
        id: "PAYPAL_ORDER_ABC123",
        status: "CREATED",
        links: [{ rel: "approve", href: "https://paypal.com/approve/ABC123" }],
      },
    });

    const result = await service.createPaypalTransaction(userId, "BK_PAYPAL");

    expect(paypalExecute).toHaveBeenCalled();
    expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        bookingId: booking._id,
        paymentMethod: "paypal",
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          paypalOrderId: "PAYPAL_ORDER_ABC123",
        }),
      }),
      expect.objectContaining({ upsert: true })
    );
    expect(result.paypalOrderId).toBe("PAYPAL_ORDER_ABC123");
    expect(result.approvalUrl).toBe("https://paypal.com/approve/ABC123");
    expect(result.bookingDetails.bookingCode).toBe("BK_PAYPAL");
  });

  it("fails with BadRequestException when PayPal execute throws", async () => {
    const booking = makeValidBooking();
    bookingModel.findOne.mockReturnValue(makeChain(booking));

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(
      service.createPaypalTransaction(userId, "BK_PAYPAL")
    ).rejects.toThrow("Failed to create PayPal order");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// finalizePaypalTransaction — happy path (COMPLETED capture)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – finalizePaypalTransaction happy path", () => {
  let service: any;
  let bookingModel: any;
  let paymentModel: any;
  let zoneModel: any;
  let redisClient: any;
  let ticketService: any;
  let userEventsService: any;
  let zoneGateway: any;
  let queueService: any;

  const orderId = "PAYPAL_ORDER_COMPLETE";
  const userId = new Types.ObjectId().toString();
  const paymentId = new Types.ObjectId();
  const bookingId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();

  const makeSession = () => ({
    withTransaction: jest
      .fn()
      .mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(async () => {
    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };

    const idemSession = makeSession();
    bookingModel = {
      db: { startSession: jest.fn().mockResolvedValue(idemSession) },
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findById: jest.fn(),
    };

    paymentModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn().mockResolvedValue(null),
    };

    zoneModel = {
      findByIdAndUpdate: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: zoneId,
            eventId: new Types.ObjectId(),
            capacity: 100,
            soldCount: 5,
            confirmedSoldCount: 3,
          }),
        }),
      }),
    };

    ticketService = {
      createTicketsFromBooking: jest.fn().mockResolvedValue([
        {
          ticketCode: "TKT001",
          seatNumber: "A1",
          qrCode: "data:image/png;base64,abc",
        },
      ]),
      publishTicketCreation: jest.fn().mockResolvedValue(undefined),
      generateMissingQRCodesForBooking: jest.fn().mockResolvedValue([
        {
          ticketCode: "TKT001",
          seatNumber: "A1",
          qrCode: "data:image/png;base64,abc",
        },
      ]),
    };

    userEventsService = {
      emitSendBookingConfirmation: jest.fn(),
    };

    zoneGateway = {
      emitZoneTicketUpdate: jest.fn(),
    };

    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: ticketService },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: zoneGateway },
        { provide: UserEventsService, useValue: userEventsService },
        { provide: QueueService, useValue: queueService },
        { provide: RedisService, useValue: { client: redisClient } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentService);

    // Set up paypalClient
    (service as any).paymentGateway.paypalClient = { execute: jest.fn() };

    const paypalModule = require("@paypal/checkout-server-sdk");
    paypalModule.orders.OrdersCaptureRequest = jest
      .fn()
      .mockImplementation(() => ({
        requestBody: jest.fn(),
      }));

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("captures PayPal payment COMPLETED and processes successfully", async () => {
    const paymentRecord = {
      _id: paymentId,
      bookingId,
      status: "pending",
      currency: "VND",
      metadata: {},
    };

    const bookingRecord = {
      bookingCode: "BK_PAYPAL",
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      isDeleted: false,
      zoneId,
      quantity: 2,
      seats: [],
      userId: new Types.ObjectId(),
      customerEmail: "user@test.com",
      customerName: "Test User",
      totalPrice: 1_000_000,
      eventId: { title: "Concert", location: "Hanoi", startDate: new Date() },
      zoneId_populated: { name: "VIP" },
    };

    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(paymentRecord),
        }),
      }),
    });

    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(bookingRecord),
        }),
      }),
    });

    // findOneAndUpdate for booking (processPaypalPayment)
    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            then: (resolve: any) =>
              Promise.resolve({
                ...bookingRecord,
                zoneId: zoneId,
                eventId: {
                  _id: new Types.ObjectId(),
                  title: "Concert",
                  location: "Hanoi",
                  startDate: new Date(),
                },
              }).then(resolve),
          }),
        }),
      }),
    });

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockResolvedValue({
      result: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [{ id: "cap_completed_123", status: "COMPLETED" }],
            },
          },
        ],
      },
    });

    const result = await service.finalizePaypalTransaction(orderId, userId);

    expect(result.status).toBe(200);
    expect(result.message).toBe("PayPal payment completed");
    expect(result.captureId).toBe("cap_completed_123");

    // Lock marked succeeded
    expect(redisClient.set).toHaveBeenCalledWith(
      `paypal:lock:${orderId}`,
      "succeeded",
      expect.any(Object)
    );

    // Tickets created
    expect(ticketService.createTicketsFromBooking).toHaveBeenCalledWith(
      "BK_PAYPAL",
      expect.any(Object)
    );

    // Confirmation delivery is now routed through NotificationService so it can be tracked/retried.
    expect(queueService.addJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "send-booking-confirmation" })
    );
  });

  it("handles publishTicketCreation failure gracefully (does not throw)", async () => {
    const paymentRecord = {
      _id: paymentId,
      bookingId,
      status: "pending",
      currency: "VND",
      metadata: {},
    };

    const bookingRecord = {
      bookingCode: "BK_PAYPAL2",
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      isDeleted: false,
      zoneId,
      quantity: 0,
      seats: [],
      userId: new Types.ObjectId(),
      customerEmail: "user@test.com",
      customerName: "Test User",
      totalPrice: 500_000,
      eventId: { title: "Concert", location: "HCMC", startDate: new Date() },
    };

    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(paymentRecord),
        }),
      }),
    });

    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(bookingRecord),
        }),
      }),
    });

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            then: (resolve: any) =>
              Promise.resolve({
                ...bookingRecord,
                zoneId,
                eventId: {
                  _id: new Types.ObjectId(),
                  title: "Concert",
                  location: "HCMC",
                  startDate: new Date(),
                },
              }).then(resolve),
          }),
        }),
      }),
    });

    ticketService.publishTicketCreation.mockRejectedValue(new Error("WS down"));

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockResolvedValue({
      result: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [{ id: "cap_pub_fail", status: "COMPLETED" }],
            },
          },
        ],
      },
    });

    const result = await service.finalizePaypalTransaction(orderId, userId);
    expect(result.status).toBe(200);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("publishTicketCreation failed")
    );
  });

  it("handles emitZoneTicketUpdate failure gracefully (PayPal path)", async () => {
    const paymentRecord = {
      _id: paymentId,
      bookingId,
      status: "pending",
      currency: "VND",
      metadata: {},
    };

    const bookingRecord = {
      bookingCode: "BK_PAYPAL3",
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      isDeleted: false,
      zoneId,
      quantity: 2,
      seats: [],
      userId: new Types.ObjectId(),
      customerEmail: "zone@test.com",
      customerName: "Zone Test",
      totalPrice: 1_000_000,
      eventId: { title: "Concert", location: "HCMC", startDate: new Date() },
    };

    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(paymentRecord),
        }),
      }),
    });

    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(bookingRecord),
        }),
      }),
    });

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            then: (resolve: any) =>
              Promise.resolve({
                ...bookingRecord,
                zoneId,
                eventId: {
                  _id: new Types.ObjectId(),
                  title: "Concert",
                  location: "HCMC",
                  startDate: new Date(),
                },
              }).then(resolve),
          }),
        }),
      }),
    });

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockResolvedValue({
      result: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [{ id: "cap_zone_fail", status: "COMPLETED" }],
            },
          },
        ],
      },
    });

    zoneGateway.emitZoneTicketUpdate.mockImplementation(() => {
      throw new Error("WebSocket error");
    });

    const result = await service.finalizePaypalTransaction(orderId, userId);
    expect(result.status).toBe(200);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("emitZoneTicketUpdate failed")
    );
  });

  it("handles notification handoff gracefully (PayPal path)", async () => {
    const paymentRecord = {
      _id: paymentId,
      bookingId,
      status: "pending",
      currency: "VND",
      metadata: {},
    };

    const bookingRecord = {
      bookingCode: "BK_PAYPAL4",
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      isDeleted: false,
      zoneId,
      quantity: 2,
      seats: [],
      userId: new Types.ObjectId(),
      customerEmail: "emailfail@test.com",
      customerName: "Email Fail",
      totalPrice: 1_000_000,
      eventId: { title: "Concert", location: "HCMC", startDate: new Date() },
    };

    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(paymentRecord),
        }),
      }),
    });

    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(bookingRecord),
        }),
      }),
    });

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            then: (resolve: any) =>
              Promise.resolve({
                ...bookingRecord,
                zoneId,
                eventId: {
                  _id: new Types.ObjectId(),
                  title: "Concert",
                  location: "HCMC",
                  startDate: new Date(),
                },
              }).then(resolve),
          }),
        }),
      }),
    });

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockResolvedValue({
      result: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [{ id: "cap_email_fail", status: "COMPLETED" }],
            },
          },
        ],
      },
    });

    const result = await service.finalizePaypalTransaction(orderId, userId);
    expect(result.status).toBe(200);
  });

  it("handles processPaypalPayment transaction failure gracefully", async () => {
    const paymentRecord = {
      _id: paymentId,
      bookingId,
      status: "pending",
      currency: "VND",
      metadata: {},
    };

    const bookingRecord = {
      bookingCode: "BK_PAYPAL5",
      status: BookingStatus.PENDING,
      paymentStatus: PaymentStatus.UNPAID,
      isDeleted: false,
      zoneId,
      quantity: 2,
    };

    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(paymentRecord),
        }),
      }),
    });

    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(bookingRecord),
        }),
      }),
    });

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            then: (_: any, reject: any) =>
              Promise.reject(new Error("Transaction aborted")).catch(reject),
          }),
        }),
      }),
    });

    const paypalExecute = (service as any).paymentGateway.paypalClient.execute;
    paypalExecute.mockResolvedValue({
      result: {
        id: orderId,
        status: "COMPLETED",
        purchase_units: [
          {
            payments: {
              captures: [{ id: "cap_txn_fail", status: "COMPLETED" }],
            },
          },
        ],
      },
    });

    await expect(
      service.finalizePaypalTransaction(orderId, userId)
    ).rejects.toThrow("Transaction aborted");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getPaymentHistory
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – getPaymentHistory", () => {
  let service: any;
  let paymentModel: any;

  const userId = new Types.ObjectId().toString();

  beforeEach(async () => {
    paymentModel = {
      find: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          sort: jest.fn().mockReturnValue({
            skip: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                lean: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      }),
      countDocuments: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        {
          provide: getModelToken(Booking.name),
          useValue: { db: { startSession: jest.fn() } },
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        { provide: RedisService, useValue: { client: {} } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentService);

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("returns paginated payment history with meta", async () => {
    const payments = [
      { _id: new Types.ObjectId(), amount: 100000, status: "succeeded" },
    ];
    paymentModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue(payments),
              }),
            }),
          }),
        }),
      }),
    });
    paymentModel.countDocuments.mockResolvedValue(1);

    const result = await service.getPaymentHistory(userId, {
      page: 1,
      limit: 10,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
    expect(result.meta.totalItems).toBe(1);
    expect(result.meta.totalPages).toBe(1);
    expect(result.meta.hasPreviousPage).toBe(false);
    expect(result.meta.hasNextPage).toBe(false);
  });

  it("throws BadRequestException when status filter is invalid", async () => {
    await expect(
      service.getPaymentHistory(userId, { status: "bogus_status" })
    ).rejects.toThrow("Invalid payment status filter");
  });

  it("throws BadRequestException when sortBy field is invalid", async () => {
    await expect(
      service.getPaymentHistory(userId, { sortBy: "invalidField" })
    ).rejects.toThrow("Invalid sortBy field");
  });

  it("accepts valid sortBy fields: createdAt, paidAt, updatedAt", async () => {
    paymentModel.find.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
      }),
    });
    paymentModel.countDocuments.mockResolvedValue(0);

    await expect(
      service.getPaymentHistory(userId, { sortBy: "paidAt" })
    ).resolves.toBeDefined();
    await expect(
      service.getPaymentHistory(userId, { sortBy: "updatedAt" })
    ).resolves.toBeDefined();
  });

  it("uses asc sortOrder when specified", async () => {
    const chain = {
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    paymentModel.find.mockReturnValue(chain);
    paymentModel.countDocuments.mockResolvedValue(0);

    await service.getPaymentHistory(userId, { sortOrder: "asc" });

    expect(chain.sort).toHaveBeenCalledWith({ createdAt: 1 });
  });

  it("passes status filter when valid status is provided", async () => {
    const chain = {
      populate: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([]),
    };
    paymentModel.find.mockReturnValue(chain);
    paymentModel.countDocuments.mockResolvedValue(0);

    await service.getPaymentHistory(userId, { status: "succeeded" });

    expect(paymentModel.find).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleChargeDisputeCreated
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – handleChargeDisputeCreated", () => {
  let service: any;
  let bookingModel: any;
  let queueService: any;

  beforeEach(async () => {
    bookingModel = {
      findOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
      db: { startSession: jest.fn() },
    };

    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: queueService },
        { provide: RedisService, useValue: { client: {} } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentService);

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("does nothing when payment_intent is missing from dispute", async () => {
    const dispute = { id: "dp_1", payment_intent: undefined } as any;

    await service.handleChargeDisputeCreated(dispute);

    expect(bookingModel.findOne).not.toHaveBeenCalled();
  });

  it("does nothing when no booking is found for the payment intent", async () => {
    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockResolvedValue(null),
    });
    const dispute = {
      id: "dp_2",
      payment_intent: "pi_123",
      reason: "fraud",
      amount: 50000,
      evidence_details: { due_by: 9999999999 },
    } as any;

    await service.handleChargeDisputeCreated(dispute);

    expect(bookingModel.updateOne).not.toHaveBeenCalled();
  });

  it("updates booking with dispute info and enqueues alert", async () => {
    const bookingId = new Types.ObjectId();
    bookingModel.findOne.mockReturnValue({
      select: jest
        .fn()
        .mockResolvedValue({ _id: bookingId, bookingCode: "BK_DISPUTE" }),
    });

    const dispute = {
      id: "dp_3",
      payment_intent: "pi_456",
      reason: "unauthorized",
      amount: 100000,
      evidence_details: { due_by: Math.floor(Date.now() / 1000) + 86400 },
    } as any;

    await service.handleChargeDisputeCreated(dispute);

    expect(bookingModel.updateOne).toHaveBeenCalledWith(
      { _id: bookingId },
      expect.objectContaining({
        $set: expect.objectContaining({
          disputeId: "dp_3",
          disputeReason: "unauthorized",
          disputeStatus: "open",
        }),
      })
    );
    expect(queueService.addJob).toHaveBeenCalledWith(
      expect.objectContaining({ type: "refund-failure-alert" })
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleCheckoutSessionExpired
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – handleCheckoutSessionExpired", () => {
  let service: any;
  let redisClient: any;

  beforeEach(async () => {
    redisClient = {
      del: jest.fn().mockResolvedValue(1),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: {} },
        {
          provide: getModelToken(Booking.name),
          useValue: { db: { startSession: jest.fn() } },
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        { provide: RedisService, useValue: { client: redisClient } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentService);

    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("deletes the dedup cache key when session expires with bookingId", async () => {
    const session = {
      id: "cs_expired",
      metadata: { bookingId: "507f1f77bcf86cd799439011" },
    } as any;

    await service.handleCheckoutSessionExpired(session);

    expect(redisClient.del).toHaveBeenCalledWith(
      "checkout:session:507f1f77bcf86cd799439011"
    );
  });

  it("does nothing when metadata or bookingId is missing", async () => {
    const session = { id: "cs_expired_no_meta", metadata: null } as any;

    await service.handleCheckoutSessionExpired(session);

    expect(redisClient.del).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// handleCheckoutSessionCompleted — additional branches
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – handleCheckoutSessionCompleted additional branches", () => {
  let service: any;
  let bookingModel: any;
  let paymentModel: any;
  let zoneModel: any;
  let ticketService: any;
  let userEventsService: any;
  let zoneGateway: any;
  let queueService: any;

  const makeSession = () => ({
    withTransaction: jest
      .fn()
      .mockImplementation(async (fn: () => Promise<unknown>) => fn()),
    endSession: jest.fn().mockResolvedValue(undefined),
  });

  const bookingId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();

  beforeEach(async () => {
    const dbSession = makeSession();
    bookingModel = {
      db: { startSession: jest.fn().mockResolvedValue(dbSession) },
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
    };

    paymentModel = {
      findOneAndUpdate: jest.fn().mockResolvedValue({}),
    };

    zoneModel = {
      findByIdAndUpdate: jest.fn().mockResolvedValue(null),
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: zoneId,
            eventId: new Types.ObjectId(),
            capacity: 100,
            soldCount: 10,
            confirmedSoldCount: 8,
          }),
        }),
      }),
    };

    ticketService = {
      createTicketsFromBooking: jest
        .fn()
        .mockResolvedValue([
          { ticketCode: "TKT100", seatNumber: "B2", qrCode: "data:qr" },
        ]),
      publishTicketCreation: jest.fn().mockResolvedValue(undefined),
      generateMissingQRCodesForBooking: jest
        .fn()
        .mockResolvedValue([
          { ticketCode: "TKT100", seatNumber: "B2", qrCode: "data:qr" },
        ]),
    };

    userEventsService = {
      emitSendBookingConfirmation: jest.fn(),
    };

    zoneGateway = {
      emitZoneTicketUpdate: jest.fn(),
    };

    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: ticketService },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: zoneGateway },
        { provide: UserEventsService, useValue: userEventsService },
        { provide: QueueService, useValue: queueService },
        {
          provide: RedisService,
          useValue: { client: { del: jest.fn().mockResolvedValue(1) } },
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
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentService);

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it("updates zone confirmedSoldCount when booking.quantity > 0", async () => {
    const session = {
      id: "cs_zone_update",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_ZONE",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_zone_update",
      amount_total: 200000,
      currency: "vnd",
      customer_details: { email: "test@test.com", name: "Test", phone: "123" },
    } as any;

    const confirmedBooking = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 3,
      seats: [],
      bookingCode: "BK_ZONE",
      zoneId,
      eventId: {
        _id: new Types.ObjectId(),
        title: "Concert",
        location: "HN",
        startDate: new Date(),
      },
      userId: new Types.ObjectId(),
      customerEmail: "test@test.com",
      customerName: "Test",
      totalPrice: 200000,
    };

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue(confirmedBooking),
        }),
      }),
    });

    await service.handleCheckoutSessionCompleted(session);

    expect(zoneModel.findByIdAndUpdate).toHaveBeenCalledWith(
      zoneId,
      expect.arrayContaining([
        expect.objectContaining({
          $set: expect.objectContaining({
            confirmedSoldCount: expect.any(Object),
          }),
        }),
      ]),
      expect.objectContaining({ session: expect.any(Object) })
    );
    expect(zoneGateway.emitZoneTicketUpdate).toHaveBeenCalled();
  });

  it("handles eventId from raw query when booking.eventId is missing", async () => {
    const eventId = new Types.ObjectId();
    const session = {
      id: "cs_raw_event",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_RAW",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_raw_event",
      amount_total: 300000,
      currency: "vnd",
      customer_details: { email: "a@b.com", name: "A", phone: null },
    } as any;

    // findOneAndUpdate returns null — triggers fallback
    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(null),
        }),
      }),
    });

    // First findOne for booking re-read — booking exists, CONFIRMED+PAID but eventId is raw ObjectId (not populated)
    const fallbackBooking = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 0,
      bookingCode: "BK_RAW",
      zoneId,
      eventId: undefined,
      userId: new Types.ObjectId(),
      customerEmail: "a@b.com",
      totalPrice: 300000,
    };

    // Second findOne as raw query for eventId — returns eventId
    const rawDoc = { _id: bookingId, eventId };

    bookingModel.findOne
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockReturnValue({
            populate: jest.fn().mockReturnValue({
              populate: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue(fallbackBooking),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(rawDoc),
        }),
      });

    await expect(
      service.handleCheckoutSessionCompleted(session)
    ).resolves.toBeUndefined();
  });

  it("throws when eventId is missing from booking in fallback path", async () => {
    const session = {
      id: "cs_no_event",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_NOEV",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_no_event",
      amount_total: 100000,
      currency: "vnd",
      customer_details: null,
    } as any;

    // findOneAndUpdate returns null
    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(null),
        }),
      }),
    });

    // First findOne for booking re-read — booking is not CONFIRMED+PAID, so shouldRefund=true
    // The booking has eventId=undefined, which after refund path is taken
    // But we need the raw query path to be triggered.
    // This test needs: re-read returns CONFIRMED+PAID with eventId=undefined,
    // then raw query returns eventId=undefined too.
    const reReadBooking = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 0,
      bookingCode: "BK_NOEV",
      zoneId,
      eventId: undefined,
      userId: new Types.ObjectId(),
      customerEmail: "a@b.com",
      totalPrice: 100000,
    };

    bookingModel.findOne
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockReturnValue({
            populate: jest.fn().mockReturnValue({
              populate: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue(reReadBooking),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ _id: bookingId, eventId: undefined }),
        }),
      });

    await expect(
      service.handleCheckoutSessionCompleted(session)
    ).rejects.toThrow("eventId reference missing from booking");
  });

  it("handles emitZoneTicketUpdate failure gracefully", async () => {
    const session = {
      id: "cs_emit_fail",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_EMIT",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_emit_fail",
      amount_total: 150000,
      currency: "vnd",
      customer_details: { email: "emit@test.com", name: "Emit", phone: null },
    } as any;

    const confirmedBooking = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 1,
      seats: ["A1"],
      bookingCode: "BK_EMIT",
      zoneId,
      eventId: {
        _id: new Types.ObjectId(),
        title: "Concert",
        location: "DN",
        startDate: new Date(),
      },
      userId: new Types.ObjectId(),
      customerEmail: "emit@test.com",
      customerName: "Emit",
      totalPrice: 150000,
    };

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue(confirmedBooking),
        }),
      }),
    });

    zoneGateway.emitZoneTicketUpdate.mockImplementation(() => {
      throw new Error("WS error");
    });

    await expect(
      service.handleCheckoutSessionCompleted(session)
    ).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("emitZoneTicketUpdate failed")
    );
  });

  it("skips sending email when shouldSendConfirmation is false", async () => {
    const session = {
      id: "cs_no_mail",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_NOMAIL",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_no_mail",
      amount_total: 100000,
      currency: "vnd",
      customer_details: null,
    } as any;

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(null),
        }),
      }),
    });

    // Re-read: booking is confirmed — shouldRefund = false, shouldSendConfirmation = false
    const alreadyConfirmed = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 0,
      bookingCode: "BK_NOMAIL",
      zoneId,
      eventId: {
        _id: new Types.ObjectId(),
        title: "Concert",
        location: "SG",
        startDate: new Date(),
      },
      userId: new Types.ObjectId(),
      totalPrice: 100000,
    };

    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            populate: jest.fn().mockReturnValue({
              populate: jest.fn().mockReturnValue(alreadyConfirmed),
            }),
          }),
        }),
      }),
    });

    await service.handleCheckoutSessionCompleted(session);
    expect(queueService.addJob).not.toHaveBeenCalled();
  });

  it("returns early when bookingForMail is null (shouldRefund path)", async () => {
    const session = {
      id: "cs_refund_only",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_REFONLY",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_refund_only",
      amount_total: 500000,
      currency: "vnd",
      customer_details: null,
    } as any;

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockResolvedValue(null),
        }),
      }),
    });

    const refundPathBooking = {
      _id: bookingId,
      status: BookingStatus.CANCELLED,
      paymentStatus: PaymentStatus.UNPAID,
    };

    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue({
            populate: jest.fn().mockReturnValue({
              populate: jest.fn().mockReturnValue(refundPathBooking),
            }),
          }),
        }),
      }),
    });

    await expect(
      service.handleCheckoutSessionCompleted(session)
    ).resolves.toBeUndefined();
    expect(ticketService.createTicketsFromBooking).not.toHaveBeenCalled();
    expect(queueService.addJob).not.toHaveBeenCalled();
  });

  it("handles publishTicketCreation failure gracefully (Stripe path)", async () => {
    const session = {
      id: "cs_pub_fail",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_PUBFAIL",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_pub_fail",
      amount_total: 100000,
      currency: "vnd",
      customer_details: null,
    } as any;

    const confirmedBooking = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 1,
      seats: [],
      bookingCode: "BK_PUBFAIL",
      zoneId,
      eventId: {
        _id: new Types.ObjectId(),
        title: "Concert",
        location: "HN",
        startDate: new Date(),
      },
      userId: new Types.ObjectId(),
      customerEmail: "pubfail@test.com",
      customerName: "PubFail",
      totalPrice: 100000,
    };

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue(confirmedBooking),
        }),
      }),
    });

    ticketService.publishTicketCreation.mockRejectedValue(
      new Error("WS timeout")
    );

    await expect(
      service.handleCheckoutSessionCompleted(session)
    ).resolves.toBeUndefined();
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("publishTicketCreation failed (payment confirmed")
    );
  });

  it("hands off Stripe confirmation delivery without failing settlement", async () => {
    const session = {
      id: "cs_email_fail",
      metadata: {
        userId: new Types.ObjectId().toString(),
        bookingCode: "BK_EMAILFAIL",
        bookingId: bookingId.toString(),
      },
      payment_intent: "pi_email_fail",
      amount_total: 100000,
      currency: "vnd",
      customer_details: { email: "fail@test.com", name: "Fail", phone: null },
    } as any;

    const confirmedBooking = {
      _id: bookingId,
      status: BookingStatus.CONFIRMED,
      paymentStatus: PaymentStatus.PAID,
      quantity: 1,
      seats: ["A1"],
      bookingCode: "BK_EMAILFAIL",
      zoneId,
      eventId: {
        _id: new Types.ObjectId(),
        title: "Concert",
        location: "HN",
        startDate: new Date(),
      },
      zoneId_populated: { name: "VIP" },
      userId: new Types.ObjectId(),
      customerEmail: "fail@test.com",
      customerName: "Fail",
      totalPrice: 100000,
    };

    bookingModel.findOneAndUpdate.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        populate: jest.fn().mockReturnValue({
          populate: jest.fn().mockReturnValue(confirmedBooking),
        }),
      }),
    });

    await expect(
      service.handleCheckoutSessionCompleted(session)
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// issueAdminRefund
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentService – issueAdminRefund", () => {
  let service: any;
  let mockStripe: any;
  let paymentModel: any;
  let bookingModel: any;
  let queueService: any;

  beforeEach(async () => {
    mockStripe = { refunds: { create: jest.fn() } };
    paymentModel = {
      findOne: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    bookingModel = {
      db: { startSession: jest.fn() },
      updateOne: jest.fn().mockResolvedValue({}),
    };
    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        {
          provide: getModelToken(Booking.name),
          useValue: bookingModel,
        },
        { provide: getModelToken(Zone.name), useValue: {} },
        { provide: getModelToken(Ticket.name), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: queueService },
        { provide: RedisService, useValue: { client: {} } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
            bookingsTotal: { inc: jest.fn() },
            checkinsTotal: { inc: jest.fn() },
          },
        },
        { provide: CurrencyService, useValue: { getVndPerUsd: jest.fn() } },
      ],
    }).compile();
    service = module.get(PaymentService);

    // Override stripe with mock
    Object.assign((service as any).paymentGateway.stripe, mockStripe);
    (service as any).paymentGateway.paypalClient = { execute: jest.fn() };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  describe("Stripe refund path", () => {
    it("issues Stripe refund successfully when stripePaymentIntentId is provided", async () => {
      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        "pi_stripe_123",
        "admin_1",
        "Customer request"
      );

      expect(mockStripe.refunds.create).toHaveBeenCalledWith(
        {
          payment_intent: "pi_stripe_123",
          metadata: expect.objectContaining({
            reason: "Customer request",
            source: "admin_cancel",
            adminId: "admin_1",
          }),
        },
        { idempotencyKey: expect.stringContaining("admin-refund:") }
      );
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringContaining("[REFUND] Stripe admin refund issued")
      );
    });

    it("logs CRITICAL and enqueues alert when Stripe refund fails", async () => {
      mockStripe.refunds.create.mockRejectedValue(
        new Error("Insufficient balance")
      );

      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        "pi_fail_456",
        "admin_2",
        "Admin override"
      );

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("[CRITICAL] Stripe admin refund FAILED"),
        expect.any(Object)
      );
      expect(queueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({ type: "refund-failure-alert" })
      );
    });

    it("uses idempotencyReference (not bookingId) in the Stripe idempotency key when provided — so a second, separate refund against the same booking doesn't collide with the first", async () => {
      mockStripe.refunds.create.mockResolvedValue({
        id: "re_1",
        amount: 100000,
      });
      const bookingId = new Types.ObjectId().toString();

      await service.issueAdminRefund(
        bookingId,
        "pi_stripe_123",
        "admin_1",
        "reason",
        { idempotencyReference: "refund-request-abc" }
      );

      expect(mockStripe.refunds.create).toHaveBeenCalledWith(
        expect.anything(),
        { idempotencyKey: "admin-refund:refund-request-abc" }
      );
    });

    it("falls back to bookingId for the idempotency key when no idempotencyReference is given (backward compatible)", async () => {
      mockStripe.refunds.create.mockResolvedValue({
        id: "re_1",
        amount: 100000,
      });
      const bookingId = new Types.ObjectId().toString();

      await service.issueAdminRefund(
        bookingId,
        "pi_stripe_123",
        "admin_1",
        "reason"
      );

      expect(mockStripe.refunds.create).toHaveBeenCalledWith(
        expect.anything(),
        { idempotencyKey: `admin-refund:${bookingId}` }
      );
    });

    describe("partial refund (Stripe only)", () => {
      it("passes the exact VND amount to Stripe (zero-decimal, no minor-unit conversion) and does NOT mark the booking/payment as fully refunded", async () => {
        mockStripe.refunds.create.mockResolvedValue({
          id: "re_partial",
          amount: 30000,
        });
        const bookingId = new Types.ObjectId().toString();

        const result = await service.issueAdminRefund(
          bookingId,
          "pi_stripe_123",
          "admin_1",
          "partial goodwill refund",
          { partialAmountVnd: 30000, idempotencyReference: "req-1" }
        );

        expect(mockStripe.refunds.create).toHaveBeenCalledWith(
          expect.objectContaining({
            payment_intent: "pi_stripe_123",
            amount: 30000,
          }),
          { idempotencyKey: "admin-refund:req-1" }
        );
        expect(result.status).toBe("succeeded");

        // booking must revert to PAID (not REFUNDED) — customer keeps their
        // confirmed booking/tickets for a true partial refund.
        expect(bookingModel.updateOne).toHaveBeenCalledWith(
          expect.objectContaining({
            paymentStatus: PaymentStatus.REFUND_PENDING,
          }),
          { $set: { paymentStatus: PaymentStatus.PAID } }
        );

        // Payment document uses the schema's existing "partially_refunded"
        // status, and $inc's refundAmount rather than overwriting it.
        expect(paymentModel.updateOne).toHaveBeenCalledWith(
          expect.objectContaining({ bookingId: expect.anything() }),
          expect.objectContaining({
            $set: expect.objectContaining({ status: "partially_refunded" }),
            $inc: { refundAmount: 30000 },
          })
        );
      });

      it("omits the amount field entirely for a full refund (Stripe refunds whatever remains, exactly as before this fix)", async () => {
        mockStripe.refunds.create.mockResolvedValue({
          id: "re_full",
          amount: 100000,
        });

        await service.issueAdminRefund(
          new Types.ObjectId().toString(),
          "pi_stripe_123",
          "admin_1",
          "full refund"
        );

        const [callArgs] = mockStripe.refunds.create.mock.calls[0];
        expect(callArgs).not.toHaveProperty("amount");

        expect(bookingModel.updateOne).toHaveBeenCalledWith(
          expect.objectContaining({
            paymentStatus: PaymentStatus.REFUND_PENDING,
          }),
          { $set: { paymentStatus: PaymentStatus.REFUNDED } }
        );
        expect(paymentModel.updateOne).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            $set: expect.objectContaining({ status: "refunded" }),
          })
        );
      });
    });
  });

  describe("PayPal refund path", () => {
    it("issues PayPal refund successfully when PayPal capture is found", async () => {
      paymentModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ paypalCaptureId: "capture_paypal_123" }),
        }),
      });

      const paypalExecute = (service as any).paymentGateway.paypalClient
        .execute;
      paypalExecute.mockResolvedValue({ result: { status: "COMPLETED" } });

      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        undefined,
        "admin_3",
        "PayPal refund reason"
      );

      expect(paypalExecute).toHaveBeenCalled();
      expect(Logger.prototype.log).toHaveBeenCalledWith(
        expect.stringContaining("[REFUND] PayPal admin refund issued")
      );
    });

    it("sets a PayPal-Request-Id via payPalRequestId() keyed by idempotencyReference — retries of the same refund request collapse into one provider refund", async () => {
      paymentModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ paypalCaptureId: "capture_paypal_idem" }),
        }),
      });

      const paypalExecute = (service as any).paymentGateway.paypalClient
        .execute;
      paypalExecute.mockResolvedValue({ result: { status: "COMPLETED" } });

      const paypalModule = require("@paypal/checkout-server-sdk");
      const refundRequestCtor = paypalModule.payments.CapturesRefundRequest;
      refundRequestCtor.mockClear();

      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        undefined,
        "admin_3",
        "PayPal refund reason",
        { idempotencyReference: "refund-request-xyz" }
      );

      const createdInstance = refundRequestCtor.mock.results[0].value;
      expect(createdInstance.payPalRequestId).toHaveBeenCalledWith(
        "admin-refund:refund-request-xyz"
      );
    });

    it("logs CRITICAL and enqueues alert when PayPal refund fails", async () => {
      paymentModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ paypalCaptureId: "capture_fail" }),
        }),
      });

      const paypalExecute = (service as any).paymentGateway.paypalClient
        .execute;
      paypalExecute.mockRejectedValue(new Error("PayPal API error"));

      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        undefined,
        "admin_4",
        "Reason"
      );

      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("[CRITICAL] PayPal admin refund FAILED"),
        expect.any(Object)
      );
      expect(queueService.addJob).toHaveBeenCalled();
    });

    it("warns and returns early when no refundable PayPal capture is found", async () => {
      paymentModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      });

      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        undefined,
        "admin_5",
        "No payment"
      );

      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining("no refundable payment found")
      );
      expect(
        (service as any).paymentGateway.paypalClient.execute
      ).not.toHaveBeenCalled();
    });

    it("warns and returns early when payment has no paypalCaptureId", async () => {
      paymentModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ paypalCaptureId: undefined }),
        }),
      });

      await service.issueAdminRefund(
        new Types.ObjectId().toString(),
        undefined,
        "admin_6",
        "No capture"
      );

      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining("no refundable payment found")
      );
    });

    it("rejects a partial refund amount for a PayPal payment (no stripePaymentIntentId) instead of silently doing a full refund", async () => {
      const paypalExecute = (service as any).paymentGateway.paypalClient
        .execute;

      await expect(
        service.issueAdminRefund(
          new Types.ObjectId().toString(),
          undefined,
          "admin_7",
          "attempted partial",
          { partialAmountVnd: 10000 }
        )
      ).rejects.toThrow(
        "Partial refunds are not supported for PayPal payments"
      );
      expect(paypalExecute).not.toHaveBeenCalled();
    });
  });
});
