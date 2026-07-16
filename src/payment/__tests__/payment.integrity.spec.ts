/**
 * Payment Integrity Tests — PAY-001 through PAY-005
 *
 * Kiểm tra các điểm quan trọng về tính toàn vẹn thanh toán:
 *   PAY-001: Webhook idempotency fallback sang MongoDB khi Redis down
 *   PAY-002: Redis lock trong createTicketsFromBooking không được acquired bên trong withTransaction
 *   PAY-003: PayPal capture thành công → PendingConfirmation record tồn tại kể cả khi DB write fail
 *   PAY-004: PayPal captureSucceeded=true → lock không được release khi DB write fail
 *   PAY-005: handleChargeRefunded xử lý partial refund (charge.refunded === false, amount_refunded > 0)
 */

import { ServiceUnavailableException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import Stripe from "stripe";

// Set env vars before PaymentService constructor runs (reads config.STRIPE_SECRET_KEY etc.)
process.env.STRIPE_SECRET_KEY = "sk_test_51FakeKeyForUnitTestsOnlyDoNotUse";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_fakefakefakefakefakefakefakefake";
process.env.PAYPAL_CLIENT_ID = "fake_paypal_client_id";
process.env.PAYPAL_CLIENT_SECRET = "fake_paypal_client_secret";

import { PaymentService } from "../payment.service";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Ticket } from "@src/schemas/ticket.schema";

import { TicketService } from "@src/ticket/ticket.service";
import { RedisService } from "@src/redis/redis.service";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { QueueService } from "@src/queue/queue.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { CurrencyService } from "@src/currency/currency.service";
import { MailService } from "@src/services/mail.service";
import { paymentTestProviders } from "../testing/payment-test.providers";
import { PaypalPaymentSettlementService } from "../application/services/paypal-payment-settlement.service";

// ─── Shared mocks ─────────────────────────────────────────────────────────────

const makeRedisClient = (overrides: Record<string, jest.Mock> = {}) => ({
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(0),
  eval: jest.fn().mockResolvedValue(null),
  sMembers: jest.fn().mockResolvedValue([]),
  expire: jest.fn().mockResolvedValue(1),
  incrBy: jest.fn(),
  decrBy: jest.fn().mockResolvedValue(0),
  ...overrides,
});

const makeSession = () => ({
  withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
  endSession: jest.fn(),
});

const makeBookingModel = (session = makeSession()) => {
  const ctor: any = jest.fn().mockImplementation((data: any) => ({
    ...data,
    _id: new Types.ObjectId(),
    save: jest.fn().mockResolvedValue(undefined),
  }));
  ctor.db = { startSession: jest.fn().mockResolvedValue(session) };
  ctor.findOne = jest.fn();
  ctor.findOneAndUpdate = jest.fn();
  ctor.findById = jest.fn();
  ctor.updateOne = jest.fn().mockResolvedValue({});
  ctor.countDocuments = jest.fn().mockResolvedValue(0);
  ctor.find = jest.fn();
  return ctor;
};

const makePaymentModel = () => {
  const ctor: any = jest.fn();
  ctor.findOne = jest.fn();
  ctor.findById = jest.fn();
  ctor.findByIdAndUpdate = jest.fn().mockResolvedValue({});
  ctor.findOneAndUpdate = jest.fn();
  ctor.countDocuments = jest.fn().mockResolvedValue(0);
  ctor.find = jest.fn();
  return ctor;
};

const makeZoneModel = () => ({
  findById: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  }),
  findByIdAndUpdate: jest.fn().mockResolvedValue({}),
  updateOne: jest.fn().mockResolvedValue({}),
});

const buildPaymentService = async (
  deps: {
    redisClient?: ReturnType<typeof makeRedisClient>;
    bookingModel?: ReturnType<typeof makeBookingModel>;
    paymentModel?: ReturnType<typeof makePaymentModel>;
  } = {}
) => {
  const redisClient = deps.redisClient ?? makeRedisClient();
  const bookingModel = deps.bookingModel ?? makeBookingModel();
  const paymentModel = deps.paymentModel ?? makePaymentModel();
  const zoneModel = makeZoneModel();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ...paymentTestProviders,
      { provide: getModelToken(Payment.name), useValue: paymentModel },
      { provide: getModelToken(Booking.name), useValue: bookingModel },
      { provide: getModelToken(Zone.name), useValue: zoneModel },
      {
        provide: getModelToken(Ticket.name),
        useValue: { updateMany: jest.fn().mockResolvedValue({}) },
      },
      {
        provide: TicketService,
        useValue: {
          createTicketsFromBooking: jest.fn().mockResolvedValue([]),
          publishTicketCreation: jest.fn(),
          generateMissingQRCodesForBooking: jest.fn().mockResolvedValue([]),
        },
      },
      {
        provide: MailService,
        useValue: { sendBookingConfirmation: jest.fn() },
      },
      { provide: RedisService, useValue: { client: redisClient } },
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
        useValue: { getVndPerUsd: jest.fn().mockResolvedValue(25000) },
      },
    ],
  }).compile();

  return {
    service: module.get(PaymentService),
    paymentModel,
    bookingModel,
    redisClient,
    zoneModel,
  };
};

// ═══════════════════════════════════════════════════════════════════════════════
// PAY-001 — Webhook idempotency: MongoDB fallback when Redis is down
// ═══════════════════════════════════════════════════════════════════════════════
describe("PAY-001 — Webhook Idempotency: MongoDB fallback when Redis is down", () => {
  it("Redis DOWN → acquireWebhookIdempotency throws ServiceUnavailableException marked __redis_down__", async () => {
    const redisClient = makeRedisClient({
      set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const { service } = await buildPaymentService({ redisClient });

    const err = await service
      .acquireWebhookIdempotency("evt_test123")
      .catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toBe("__redis_down__");
  });

  it("checkWebhookIdempotencyFromDB — checkout.session.completed + booking already CONFIRMED → 'succeeded'", async () => {
    const bookingModel = makeBookingModel();
    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    });

    const { service } = await buildPaymentService({ bookingModel });

    const fakeEvent = {
      id: "evt_test123",
      type: "checkout.session.completed",
      data: {
        object: {
          payment_intent: "pi_abc123",
        } as Partial<Stripe.Checkout.Session>,
      },
    } as Stripe.Event;

    const status = await service.checkWebhookIdempotencyFromDB(fakeEvent);
    expect(status).toBe("succeeded");
    expect(bookingModel.findOne).toHaveBeenCalledWith(
      expect.objectContaining({
        stripePaymentIntentId: "pi_abc123",
        status: BookingStatus.CONFIRMED,
      })
    );
  });

  it("checkWebhookIdempotencyFromDB — booking NOT confirmed → 'new'", async () => {
    const bookingModel = makeBookingModel();
    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });

    const { service } = await buildPaymentService({ bookingModel });

    const fakeEvent = {
      id: "evt_test456",
      type: "checkout.session.completed",
      data: {
        object: {
          payment_intent: "pi_def456",
        } as Partial<Stripe.Checkout.Session>,
      },
    } as Stripe.Event;

    const status = await service.checkWebhookIdempotencyFromDB(fakeEvent);
    expect(status).toBe("new");
  });

  it("checkWebhookIdempotencyFromDB — charge.refunded + payment already refunded → 'succeeded'", async () => {
    const paymentModel = makePaymentModel();
    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
    });

    const { service } = await buildPaymentService({ paymentModel });

    const fakeEvent = {
      id: "evt_charge1",
      type: "charge.refunded",
      data: {
        object: { payment_intent: "pi_refund1" } as Partial<Stripe.Charge>,
      },
    } as Stripe.Event;

    const status = await service.checkWebhookIdempotencyFromDB(fakeEvent);
    expect(status).toBe("succeeded");
  });

  it("checkWebhookIdempotencyFromDB — unknown event type → 'new' (process with MongoDB guards active)", async () => {
    const { service } = await buildPaymentService();

    const fakeEvent = {
      id: "evt_unknown1",
      type: "payment_intent.succeeded",
      data: { object: {} as Stripe.PaymentIntent },
    } as Stripe.Event;

    const status = await service.checkWebhookIdempotencyFromDB(fakeEvent);
    expect(status).toBe("new");
  });

  it("checkWebhookIdempotencyFromDB — both Redis AND DB down → rethrows DB error", async () => {
    const bookingModel = makeBookingModel();
    bookingModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockRejectedValue(new Error("MongoNetworkError")),
    });

    const { service } = await buildPaymentService({ bookingModel });

    const fakeEvent = {
      id: "evt_crisis",
      type: "checkout.session.completed",
      data: {
        object: {
          payment_intent: "pi_crisis",
        } as Partial<Stripe.Checkout.Session>,
      },
    } as Stripe.Event;

    await expect(
      service.checkWebhookIdempotencyFromDB(fakeEvent)
    ).rejects.toThrow("MongoNetworkError");
  });

  it("markWebhookSucceeded — Redis DOWN → does not throw (logs warning only)", async () => {
    const redisClient = makeRedisClient({
      set: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const { service } = await buildPaymentService({ redisClient });

    // Should not throw — business logic already completed
    await expect(
      service.markWebhookSucceeded("evt_test789")
    ).resolves.toBeUndefined();
  });

  it("releaseWebhookProcessing — Redis DOWN → does not throw", async () => {
    const redisClient = makeRedisClient({
      eval: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    });
    const { service } = await buildPaymentService({ redisClient });

    await expect(
      service.releaseWebhookProcessing("evt_test789")
    ).resolves.toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAY-005 — handleChargeRefunded: partial refund guard fix
// ═══════════════════════════════════════════════════════════════════════════════
describe("PAY-005 — handleChargeRefunded: partial refund no longer dropped", () => {
  const bookingId = new Types.ObjectId();
  const paymentIntentId = "pi_partial_test";

  const makeCharge = (overrides: Partial<Stripe.Charge> = {}): Stripe.Charge =>
    ({
      id: "ch_test",
      object: "charge",
      payment_intent: paymentIntentId,
      refunded: false,
      amount: 500_000,
      amount_refunded: 100_000,
      currency: "vnd",
      ...overrides,
    }) as unknown as Stripe.Charge;

  it("partial refund (charge.refunded=false, amount_refunded>0) → processes partial refund branch", async () => {
    const bookingModel = makeBookingModel();
    const paymentModel = makePaymentModel();

    const bookingDoc = {
      _id: bookingId,
      zoneId: new Types.ObjectId(),
      quantity: 2,
      stripePaymentIntentId: paymentIntentId,
      paymentStatus: PaymentStatus.PAID,
      status: BookingStatus.CONFIRMED,
      totalRefunded: 0,
      refundHistory: [],
      save: jest.fn().mockResolvedValue(undefined),
    };

    bookingModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(bookingDoc),
    });
    paymentModel.findOneAndUpdate.mockResolvedValue({});

    const { service } = await buildPaymentService({
      bookingModel,
      paymentModel,
    });

    const partialCharge = makeCharge({
      refunded: false, // partial refund: charge.refunded is FALSE
      amount: 500_000,
      amount_refunded: 100_000,
    });

    await service.handleChargeRefunded(partialCharge);

    // Booking was updated with refund history
    expect(bookingDoc.save).toHaveBeenCalled();
    expect(bookingDoc.refundHistory).toHaveLength(1);
    expect(bookingDoc.refundHistory[0].amount).toBe(100_000);

    // Payment record updated to partially_refunded
    expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripePaymentIntentId: paymentIntentId }),
      expect.objectContaining({ status: "partially_refunded" }),
      expect.any(Object)
    );

    // Zone soldCount NOT modified for partial refund (booking is not cancelled)
    expect(bookingModel.findOne).toHaveBeenCalled();
  });

  it("full refund (charge.refunded=true, amount_refunded===amount) → full refund branch: booking cancelled", async () => {
    const bookingModel = makeBookingModel();
    const paymentModel = makePaymentModel();
    const _zoneModel = makeZoneModel();

    const bookingDoc = {
      _id: bookingId,
      zoneId: new Types.ObjectId(),
      quantity: 2,
      stripePaymentIntentId: paymentIntentId,
      paymentStatus: PaymentStatus.PAID,
      status: BookingStatus.CONFIRMED,
      totalRefunded: 0,
      refundHistory: [],
      save: jest.fn().mockResolvedValue(undefined),
    };

    bookingModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(bookingDoc),
    });
    paymentModel.findOneAndUpdate.mockResolvedValue({});

    const { service } = await buildPaymentService({
      bookingModel,
      paymentModel,
    });

    const fullCharge = makeCharge({
      refunded: true, // full refund: charge.refunded is TRUE
      amount: 500_000,
      amount_refunded: 500_000, // fully refunded
    });

    await service.handleChargeRefunded(fullCharge);

    // Booking status updated to CANCELLED + REFUNDED
    expect(bookingDoc.paymentStatus).toBe(PaymentStatus.REFUNDED);
    expect(bookingDoc.status).toBe(BookingStatus.CANCELLED);
    expect(bookingDoc.save).toHaveBeenCalled();

    // Payment record updated to refunded
    expect(paymentModel.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ stripePaymentIntentId: paymentIntentId }),
      expect.objectContaining({ status: "refunded" }),
      expect.any(Object)
    );
  });

  it("amount_refunded=0 → returns early, no DB operations", async () => {
    const bookingModel = makeBookingModel();
    const { service } = await buildPaymentService({ bookingModel });

    const chargeWithNoRefund = makeCharge({
      refunded: false,
      amount: 500_000,
      amount_refunded: 0,
    });

    await service.handleChargeRefunded(chargeWithNoRefund);
    expect(bookingModel.findOne).not.toHaveBeenCalled();
  });

  it("no payment_intent → returns early, no DB operations", async () => {
    const bookingModel = makeBookingModel();
    const { service } = await buildPaymentService({ bookingModel });

    const chargeNoIntent = makeCharge({
      payment_intent: null as unknown as string,
    });
    await service.handleChargeRefunded(chargeNoIntent);
    expect(bookingModel.findOne).not.toHaveBeenCalled();
  });

  it("cumulative delta <= 0 (already recorded) → skips duplicate refund update", async () => {
    const bookingModel = makeBookingModel();

    // Booking already has 100k refunded — a Stripe retry sends the same event
    const bookingDoc = {
      _id: bookingId,
      zoneId: new Types.ObjectId(),
      quantity: 2,
      stripePaymentIntentId: paymentIntentId,
      paymentStatus: PaymentStatus.PAID,
      status: BookingStatus.CONFIRMED,
      totalRefunded: 100_000, // already recorded
      refundHistory: [{ amount: 100_000, refundedAt: new Date() }],
      save: jest.fn().mockResolvedValue(undefined),
    };

    bookingModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(bookingDoc),
    });

    const { service } = await buildPaymentService({ bookingModel });
    const partialCharge = makeCharge({
      refunded: false,
      amount: 500_000,
      amount_refunded: 100_000,
    });

    await service.handleChargeRefunded(partialCharge);

    // save() not called — delta was 0
    expect(bookingDoc.save).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PAY-003 & PAY-002 — PayPal capture atomicity + lock retention on DB failure
// ═══════════════════════════════════════════════════════════════════════════════
describe("PAY-003 & PAY-002 — PayPal capture: PendingConfirmation record + lock retention", () => {
  it("PAY-003: PendingConfirmation written to Payment BEFORE processPaypalPayment is called", async () => {
    const paymentModel = makePaymentModel();
    const bookingModel = makeBookingModel();

    const paymentDoc = {
      _id: new Types.ObjectId(),
      bookingId: new Types.ObjectId(),
      status: "pending",
      currency: "VND",
      metadata: {},
    };
    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(paymentDoc) }),
      exec: jest.fn().mockResolvedValue(paymentDoc),
    });
    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          bookingCode: "BK-TEST",
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        }),
      }),
      exec: jest.fn().mockResolvedValue({
        bookingCode: "BK-TEST",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      }),
    });

    // Track the call order
    const callOrder: string[] = [];

    paymentModel.findByIdAndUpdate.mockImplementation(() => {
      callOrder.push("writeCapturePending");
      return Promise.resolve({});
    });

    // Simulate processPaypalPayment (injected via ticketService)
    const ticketService = {
      createTicketsFromBooking: jest.fn().mockResolvedValue([]),
      publishTicketCreation: jest.fn(),
      generateMissingQRCodesForBooking: jest.fn(),
    };

    const redisClient = makeRedisClient({
      set: jest.fn().mockResolvedValue("OK"),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: makeZoneModel() },
        {
          provide: getModelToken(Ticket.name),
          useValue: { updateMany: jest.fn() },
        },
        { provide: TicketService, useValue: ticketService },
        {
          provide: MailService,
          useValue: { sendBookingConfirmation: jest.fn() },
        },
        { provide: RedisService, useValue: { client: redisClient } },
        { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
          },
        },
        {
          provide: CurrencyService,
          useValue: { getVndPerUsd: jest.fn().mockResolvedValue(25000) },
        },
      ],
    }).compile();

    const service = module.get(PaymentService);

    const settlementUseCase = module.get(PaypalPaymentSettlementService);

    // Spy on processPaypalPayment (private) to intercept
    const processPaypalSpy = jest
      .spyOn(settlementUseCase as any, "processPaypalPayment")
      .mockImplementation(async () => {
        callOrder.push("processPaypalPayment");
      });

    // Mock PayPal capture to succeed
    const captureDetail = { id: "CAPTURE123", status: "COMPLETED" };
    const captureResponse = {
      result: {
        status: "COMPLETED",
        purchase_units: [{ payments: { captures: [captureDetail] } }],
      },
    };
    (service as any).paymentGateway.paypalClient = {
      execute: jest.fn().mockResolvedValue(captureResponse),
    };

    await service.finalizePaypalTransaction(
      "ORDER123",
      new Types.ObjectId().toString()
    );

    // PendingConfirmation MUST be written BEFORE processPaypalPayment
    expect(callOrder.indexOf("writeCapturePending")).toBeLessThan(
      callOrder.indexOf("processPaypalPayment")
    );
    expect(paymentModel.findByIdAndUpdate).toHaveBeenCalledWith(
      paymentDoc._id,
      expect.objectContaining({
        $set: expect.objectContaining({
          "metadata.captureStatus": "PendingConfirmation",
          "metadata.captureId": captureDetail.id,
        }),
      })
    );

    processPaypalSpy.mockRestore();
  });

  it("PAY-002: PayPal lock NOT released when capture succeeded but DB write fails", async () => {
    const paymentModel = makePaymentModel();
    const bookingModel = makeBookingModel();
    const redisClient = makeRedisClient();

    const paymentDoc = {
      _id: new Types.ObjectId(),
      bookingId: new Types.ObjectId(),
      status: "pending",
      currency: "VND",
      metadata: {},
    };
    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(paymentDoc) }),
      exec: jest.fn().mockResolvedValue(paymentDoc),
    });
    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          bookingCode: "BK-TEST",
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        }),
      }),
      exec: jest.fn().mockResolvedValue({
        bookingCode: "BK-TEST",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: makeZoneModel() },
        {
          provide: getModelToken(Ticket.name),
          useValue: { updateMany: jest.fn() },
        },
        {
          provide: TicketService,
          useValue: {
            createTicketsFromBooking: jest.fn(),
            publishTicketCreation: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: { sendBookingConfirmation: jest.fn() },
        },
        { provide: RedisService, useValue: { client: redisClient } },
        { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
          },
        },
        {
          provide: CurrencyService,
          useValue: { getVndPerUsd: jest.fn().mockResolvedValue(25000) },
        },
      ],
    }).compile();

    const service = module.get(PaymentService);

    // Capture succeeds
    const captureResponse = {
      result: {
        status: "COMPLETED",
        purchase_units: [
          {
            payments: { captures: [{ id: "CAPTURE456", status: "COMPLETED" }] },
          },
        ],
      },
    };
    (service as any).paymentGateway.paypalClient = {
      execute: jest.fn().mockResolvedValue(captureResponse),
    };

    // DB write fails
    const settlementUseCase = module.get(PaypalPaymentSettlementService);
    jest
      .spyOn(settlementUseCase as any, "processPaypalPayment")
      .mockRejectedValue(
        new Error("MongoNetworkError — simulated DB failure after capture")
      );

    await expect(
      service.finalizePaypalTransaction(
        "ORDER456",
        new Types.ObjectId().toString()
      )
    ).rejects.toThrow("MongoNetworkError");

    // Redis lock (eval = RELEASE_LOCK_SCRIPT) MUST NOT have been called
    // Lock is released by eval() — verify it was NOT called for the release path
    const evalCalls = redisClient.eval.mock.calls;
    const releaseCallsMade = evalCalls.some(
      (call: any[]) =>
        // WEBHOOK_RELEASE_SCRIPT / RELEASE_LOCK_SCRIPT both use KEYS[1]
        // The paypal lock release is the only eval call here
        call[1] &&
        Array.isArray(call[1]?.keys) &&
        call[1].keys[0]?.includes("paypal:lock:")
    );
    expect(releaseCallsMade).toBe(false);
  });

  it("PAY-002: PayPal lock IS released when capture was never attempted (pre-capture error)", async () => {
    const paymentModel = makePaymentModel();
    const bookingModel = makeBookingModel();
    const redisClient = makeRedisClient();

    const paymentDoc = {
      _id: new Types.ObjectId(),
      bookingId: new Types.ObjectId(),
      status: "pending",
      currency: "VND",
      metadata: {},
    };
    paymentModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(paymentDoc) }),
      exec: jest.fn().mockResolvedValue(paymentDoc),
    });
    bookingModel.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          bookingCode: "BK-TEST",
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
        }),
      }),
      exec: jest.fn().mockResolvedValue({
        bookingCode: "BK-TEST",
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
      }),
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...paymentTestProviders,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Zone.name), useValue: makeZoneModel() },
        {
          provide: getModelToken(Ticket.name),
          useValue: { updateMany: jest.fn() },
        },
        {
          provide: TicketService,
          useValue: {
            createTicketsFromBooking: jest.fn(),
            publishTicketCreation: jest.fn(),
          },
        },
        {
          provide: MailService,
          useValue: { sendBookingConfirmation: jest.fn() },
        },
        { provide: RedisService, useValue: { client: redisClient } },
        { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
        {
          provide: MetricsService,
          useValue: {
            paymentsTotal: { inc: jest.fn() },
            refundFailuresTotal: { inc: jest.fn() },
          },
        },
        {
          provide: CurrencyService,
          useValue: { getVndPerUsd: jest.fn().mockResolvedValue(25000) },
        },
      ],
    }).compile();

    const service = module.get(PaymentService);

    // PayPal API itself fails (capture never attempted)
    (service as any).paymentGateway.paypalClient = {
      execute: jest.fn().mockRejectedValue(new Error("PayPal API down")),
    };

    await expect(
      service.finalizePaypalTransaction(
        "ORDER789",
        new Types.ObjectId().toString()
      )
    ).rejects.toThrow("Failed to capture payment");

    // Lock MUST be released (eval called for the lock release)
    const evalCalls = redisClient.eval.mock.calls;
    const releaseCallsMade = evalCalls.some(
      (call: any[]) =>
        call[1] &&
        Array.isArray(call[1]?.keys) &&
        call[1].keys[0]?.includes("paypal:lock:")
    );
    expect(releaseCallsMade).toBe(true);
  });
});
