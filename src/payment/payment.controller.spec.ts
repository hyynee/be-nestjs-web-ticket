import { Logger } from "@nestjs/common";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { Test, TestingModule } from "@nestjs/testing";
import { PaymentController } from "./payment.controller";
import { PaymentService } from "./payment.service";
import { PaymentOpsService } from "@src/payment-ops/payment-ops.service";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import type { Request, Response } from "express";
import Stripe from "stripe";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const makeEvent = (
  type: Stripe.Event["type"] = "checkout.session.completed",
  id = "evt_test_123"
): Stripe.Event =>
  ({
    id,
    type,
    data: { object: { id: "cs_test_1", metadata: {} } },
  }) as unknown as Stripe.Event;

const makeRes = () => {
  const json = jest.fn().mockReturnThis();
  const send = jest.fn().mockReturnThis();
  const status = jest.fn().mockReturnValue({ json, send });
  return { status, json, send } as unknown as Response;
};

const makeReq = (body: Buffer = Buffer.from("{}")) =>
  ({ rawBody: body, body }) as unknown as Request;

const makePaymentOpsService = (): jest.Mocked<
  Pick<
    PaymentOpsService,
    | "recordReceivedStripeEvent"
    | "markProcessing"
    | "markSucceeded"
    | "markIgnored"
    | "markFailed"
  >
> => ({
  recordReceivedStripeEvent: jest.fn().mockResolvedValue({ id: "webhook_1" }),
  markProcessing: jest.fn().mockResolvedValue(undefined),
  markSucceeded: jest.fn().mockResolvedValue(undefined),
  markIgnored: jest.fn().mockResolvedValue(undefined),
  markFailed: jest.fn().mockResolvedValue(undefined),
});

// ─── Suite ────────────────────────────────────────────────────────────────────

describe("PaymentController – handleWebhook idempotency", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<
    Pick<
      PaymentService,
      | "verifyWebhook"
      | "acquireWebhookIdempotency"
      | "markWebhookSucceeded"
      | "releaseWebhookProcessing"
      | "handleCheckoutSessionCompleted"
      | "handlePaymentIntentSucceeded"
    >
  >;
  let paymentOpsService: ReturnType<typeof makePaymentOpsService>;

  const req = makeReq();
  const event = makeEvent();

  beforeEach(async () => {
    paymentService = {
      verifyWebhook: jest.fn().mockReturnValue(event),
      acquireWebhookIdempotency: jest.fn(),
      markWebhookSucceeded: jest.fn().mockResolvedValue(undefined),
      releaseWebhookProcessing: jest.fn().mockResolvedValue(undefined),
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
      handlePaymentIntentSucceeded: jest.fn(),
    };
    paymentOpsService = makePaymentOpsService();

    // Silence logger output during tests
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: paymentOpsService },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  afterEach(() => jest.restoreAllMocks());

  // ── Signature verification ─────────────────────────────────────────────────

  describe("signature verification", () => {
    it("returns 400 when webhook signature is invalid", async () => {
      paymentService.verifyWebhook.mockImplementation(() => {
        throw new Error("No signatures found matching the expected signature");
      });
      const res = makeRes();

      await controller.handleWebhook("bad-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(400);
    });
  });

  // ── Redis unavailable ──────────────────────────────────────────────────────

  describe("Redis unavailable", () => {
    it("returns 503 when Redis idempotency check throws", async () => {
      paymentService.acquireWebhookIdempotency.mockRejectedValue(
        new Error("Redis connection timeout")
      );
      const res = makeRes();

      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(503);
      // Stripe retries on 503 — payment not lost
    });

    it("does NOT call the handler when Redis is unavailable", async () => {
      paymentService.acquireWebhookIdempotency.mockRejectedValue(
        new Error("Redis error")
      );

      await controller.handleWebhook("valid-sig", req, makeRes());

      expect(
        paymentService.handleCheckoutSessionCompleted
      ).not.toHaveBeenCalled();
    });
  });

  // ── Already succeeded (deduplicated) ──────────────────────────────────────

  describe('status === "succeeded" (already processed)', () => {
    beforeEach(() => {
      paymentService.acquireWebhookIdempotency.mockResolvedValue("succeeded");
    });

    it("returns 200 with deduplicated: true", async () => {
      const res = makeRes();
      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(200);
      expect(
        (res.status as jest.Mock).mock.results[0].value.json as jest.Mock
      ).toHaveBeenCalledWith({ received: true, deduplicated: true });
    });

    it("does NOT call the handler for an already succeeded event", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(
        paymentService.handleCheckoutSessionCompleted
      ).not.toHaveBeenCalled();
    });
  });

  // ── Concurrent processing ──────────────────────────────────────────────────

  describe('status === "processing" (concurrent delivery)', () => {
    beforeEach(() => {
      paymentService.acquireWebhookIdempotency.mockResolvedValue("processing");
    });

    it("returns 503 so Stripe will retry after the in-progress request completes", async () => {
      const res = makeRes();
      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(503);
    });

    it("does NOT call the handler when another instance is processing", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(
        paymentService.handleCheckoutSessionCompleted
      ).not.toHaveBeenCalled();
    });
  });

  // ── Happy path: new event, handler succeeds ────────────────────────────────

  describe('status === "new" — handler succeeds', () => {
    beforeEach(() => {
      paymentService.acquireWebhookIdempotency.mockResolvedValue("new");
      paymentService.handleCheckoutSessionCompleted.mockResolvedValue(
        undefined
      );
    });

    it("returns 200 after successful processing", async () => {
      const res = makeRes();
      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(200);
      expect(
        (res.status as jest.Mock).mock.results[0].value.json as jest.Mock
      ).toHaveBeenCalledWith({ received: true });
    });

    it("calls handleCheckoutSessionCompleted for checkout.session.completed event", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(
        paymentService.handleCheckoutSessionCompleted
      ).toHaveBeenCalledTimes(1);
    });

    it("promotes key from 'processing' to 'succeeded' after handler succeeds", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(
        event.id
      );
    });

    it("does NOT call releaseWebhookProcessing on success path", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(paymentService.releaseWebhookProcessing).not.toHaveBeenCalled();
    });

    it("calls handlePaymentIntentSucceeded for payment_intent.succeeded event", async () => {
      const piEvent = makeEvent("payment_intent.succeeded", "evt_pi_test");
      paymentService.verifyWebhook.mockReturnValue(piEvent);

      await controller.handleWebhook("valid-sig", req, makeRes());

      expect(paymentService.handlePaymentIntentSucceeded).toHaveBeenCalledTimes(
        1
      );
      expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(
        piEvent.id
      );
    });
  });

  // ── Critical: new event, handler fails ────────────────────────────────────

  describe('status === "new" — handler FAILS (the original bug)', () => {
    const handlerError = new Error(
      "MongoDB timeout during booking confirmation"
    );

    beforeEach(() => {
      paymentService.acquireWebhookIdempotency.mockResolvedValue("new");
      paymentService.handleCheckoutSessionCompleted.mockRejectedValue(
        handlerError
      );
    });

    it("returns 500 after releasing the lock so Stripe RETRIES (production fix)", async () => {
      // FIXED: handler fails, lock is released, return 500 so Stripe retries with
      // exponential backoff. The old behavior (200) silently swallowed failures —
      // a customer could be charged with no ticket issued and Stripe would never retry.
      // With 500: Stripe retries up to 72h; the idempotency key was cleared so
      // the next retry enters as "new" and succeeds if the transient error is gone.
      const res = makeRes();
      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(500);
    });

    it("releases the idempotency key on handler failure", async () => {
      // This is the core fix: releasing the key allows Stripe retry to succeed.
      // Without this, the key stays as "processing" until TTL expires,
      // then transitions to absent — Stripe sees "new" on the next retry.
      await controller.handleWebhook("valid-sig", req, makeRes());

      expect(paymentService.releaseWebhookProcessing).toHaveBeenCalledWith(
        event.id
      );
    });

    it("does NOT call markWebhookSucceeded on handler failure", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(paymentService.markWebhookSucceeded).not.toHaveBeenCalled();
    });

    it("returns 503 when both handler and releaseWebhookProcessing fail (Redis double-fail)", async () => {
      // Extreme case: handler fails AND Redis lock release fails.
      // Return 503 so Stripe retries — the key will expire after PROCESSING_TTL_SEC
      // (10 min) and the next retry will re-process as "new".
      paymentService.releaseWebhookProcessing.mockRejectedValue(
        new Error("Redis also down")
      );

      const res = makeRes();
      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(503);
    });
  });

  // ── Edge case: handler succeeds and markWebhookSucceeded resolves (PAY-001) ─

  describe("handler succeeds — markWebhookSucceeded handles Redis errors internally", () => {
    beforeEach(() => {
      paymentService.acquireWebhookIdempotency.mockResolvedValue("new");
      paymentService.handleCheckoutSessionCompleted.mockResolvedValue(
        undefined
      );
      // PAY-001: markWebhookSucceeded now catches Redis failures internally and
      // always resolves — the controller always returns 200 after successful processing.
      paymentService.markWebhookSucceeded.mockResolvedValue(undefined);
    });

    it("returns 200 after successful processing (even when Redis is flapping, service handles internally)", async () => {
      const res = makeRes();
      await controller.handleWebhook("valid-sig", req, res);

      expect((res.status as jest.Mock).mock.calls[0][0]).toBe(200);
    });

    it("does NOT call releaseWebhookProcessing when handler succeeded", async () => {
      await controller.handleWebhook("valid-sig", req, makeRes());
      expect(paymentService.releaseWebhookProcessing).not.toHaveBeenCalled();
    });
  });

  // ── Idempotency for all event types ───────────────────────────────────────

  describe("idempotency applies to all event types", () => {
    const eventTypes: Array<Stripe.Event["type"]> = [
      "checkout.session.completed",
      "payment_intent.succeeded",
    ];

    test.each(eventTypes)(
      "acquireWebhookIdempotency is called for event type: %s",
      async (type) => {
        const specificEvent = makeEvent(
          type,
          `evt_${type.replace(/\./g, "_")}`
        );
        paymentService.verifyWebhook.mockReturnValue(specificEvent);
        paymentService.acquireWebhookIdempotency.mockResolvedValue("succeeded");

        await controller.handleWebhook("valid-sig", req, makeRes());

        expect(paymentService.acquireWebhookIdempotency).toHaveBeenCalledWith(
          specificEvent.id
        );
      }
    );

    it("unhandled event type is still marked succeeded (no side effects, safe to deduplicate)", async () => {
      const unknownEvent = makeEvent(
        "customer.created" as Stripe.Event["type"],
        "evt_unknown"
      );
      paymentService.verifyWebhook.mockReturnValue(unknownEvent);
      paymentService.acquireWebhookIdempotency.mockResolvedValue("new");

      await controller.handleWebhook("valid-sig", req, makeRes());

      expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(
        unknownEvent.id
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizeRawBody — fallback paths (lines 35-39)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – normalizeRawBody fallback paths", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<
    Pick<
      PaymentService,
      | "verifyWebhook"
      | "acquireWebhookIdempotency"
      | "markWebhookSucceeded"
      | "releaseWebhookProcessing"
    >
  >;

  beforeEach(async () => {
    paymentService = {
      verifyWebhook: jest.fn(),
      acquireWebhookIdempotency: jest.fn().mockResolvedValue("succeeded"),
      markWebhookSucceeded: jest.fn().mockResolvedValue(undefined),
      releaseWebhookProcessing: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  afterEach(() => jest.restoreAllMocks());

  it("uses req.body as Buffer when rawBody is absent (line 35-37)", async () => {
    const bodyBuffer = Buffer.from(JSON.stringify({ type: "charge.refunded" }));
    const req = { body: bodyBuffer } as unknown as Request;

    const evt = makeEvent("charge.refunded", "evt_bf1");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.verifyWebhook).toHaveBeenCalledWith(
      bodyBuffer,
      "valid-sig"
    );
  });

  it("stringifies req.body when it is a plain object without rawBody (line 39)", async () => {
    const req = {
      body: { type: "checkout.session.completed" },
    } as unknown as Request;

    const evt = makeEvent("checkout.session.completed", "evt_bf2");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.verifyWebhook).toHaveBeenCalledWith(
      Buffer.from(JSON.stringify({ type: "checkout.session.completed" })),
      "valid-sig"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// All webhook event types — dispatch to correct handler (lines 120-133)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – webhook event type dispatch", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<any>;

  const req = makeReq();

  beforeEach(async () => {
    paymentService = {
      verifyWebhook: jest.fn(),
      acquireWebhookIdempotency: jest.fn().mockResolvedValue("new"),
      markWebhookSucceeded: jest.fn().mockResolvedValue(undefined),
      releaseWebhookProcessing: jest.fn().mockResolvedValue(undefined),
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
      handlePaymentIntentSucceeded: jest.fn(),
      handleChargeRefunded: jest.fn().mockResolvedValue(undefined),
      handlePaymentIntentFailed: jest.fn().mockResolvedValue(undefined),
      handleChargeDisputeCreated: jest.fn().mockResolvedValue(undefined),
      handlePaymentIntentCanceled: jest.fn().mockResolvedValue(undefined),
      handleCheckoutSessionExpired: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  afterEach(() => jest.restoreAllMocks());

  it("dispatches charge.refunded to handleChargeRefunded", async () => {
    const evt = makeEvent("charge.refunded", "evt_refund");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.handleChargeRefunded).toHaveBeenCalledWith(
      evt.data.object
    );
    expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(evt.id);
  });

  it("dispatches payment_intent.payment_failed to handlePaymentIntentFailed", async () => {
    const evt = makeEvent("payment_intent.payment_failed", "evt_fail");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.handlePaymentIntentFailed).toHaveBeenCalledWith(
      evt.data.object
    );
    expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(evt.id);
  });

  it("dispatches charge.dispute.created to handleChargeDisputeCreated", async () => {
    const evt = makeEvent("charge.dispute.created", "evt_dispute");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.handleChargeDisputeCreated).toHaveBeenCalledWith(
      evt.data.object
    );
    expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(evt.id);
  });

  it("dispatches payment_intent.canceled to handlePaymentIntentCanceled", async () => {
    const evt = makeEvent("payment_intent.canceled", "evt_pi_cancel");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.handlePaymentIntentCanceled).toHaveBeenCalledWith(
      evt.data.object
    );
    expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(evt.id);
  });

  it("dispatches checkout.session.expired to handleCheckoutSessionExpired", async () => {
    const evt = makeEvent("checkout.session.expired", "evt_expired");
    paymentService.verifyWebhook.mockReturnValue(evt);

    await controller.handleWebhook("valid-sig", req, makeRes());

    expect(paymentService.handleCheckoutSessionExpired).toHaveBeenCalledWith(
      evt.data.object
    );
    expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(evt.id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createCheckoutSession (lines 57-58)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – createCheckoutSession", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<
    Pick<PaymentService, "createCheckoutSession">
  >;
  const user = { userId: "user_123" } as any;

  beforeEach(async () => {
    paymentService = {
      createCheckoutSession: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  it("calls service.createCheckoutSession with userId and bookingCode", async () => {
    const dto = { bookingCode: "BK001" } as any;
    paymentService.createCheckoutSession.mockResolvedValue({
      status: 200,
      message: "Checkout session created successfully",
      checkoutUrl: "https://checkout.stripe.com/pay/cs_test",
    });

    const result = await controller.createCheckoutSession(user, dto);

    expect(paymentService.createCheckoutSession).toHaveBeenCalledWith(
      "user_123",
      "BK001"
    );
    expect(result.checkoutUrl).toBe("https://checkout.stripe.com/pay/cs_test");
  });

  it("requires VerifiedUserGuard in addition to AuthGuard(jwt)", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      controller.createCheckoutSession
    );
    expect(guards).toContain(VerifiedUserGuard);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// createPaypalTransaction (lines 187-188)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – createPaypalTransaction", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<
    Pick<PaymentService, "createPaypalTransaction">
  >;
  const user = { userId: "user_456" } as any;

  beforeEach(async () => {
    paymentService = {
      createPaypalTransaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  it("calls service.createPaypalTransaction with userId and bookingCode", async () => {
    const dto = { bookingCode: "BK002" } as any;
    paymentService.createPaypalTransaction.mockResolvedValue({
      status: 200,
      message: "PayPal order created successfully",
      paypalOrderId: "PAYPAL_ORDER_123",
      approvalUrl: "https://paypal.com/approve/abc",
    });

    const result = await controller.createPaypalTransaction(user, dto);

    expect(paymentService.createPaypalTransaction).toHaveBeenCalledWith(
      "user_456",
      "BK002"
    );
    expect(result.paypalOrderId).toBe("PAYPAL_ORDER_123");
    expect(result.approvalUrl).toBe("https://paypal.com/approve/abc");
  });

  it("requires VerifiedUserGuard in addition to AuthGuard(jwt)", () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      controller.createPaypalTransaction
    );
    expect(guards).toContain(VerifiedUserGuard);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// finalizePaypalTransaction (lines 203-207)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – finalizePaypalTransaction", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<
    Pick<PaymentService, "finalizePaypalTransaction">
  >;
  const user = { userId: "user_789" } as any;

  beforeEach(async () => {
    paymentService = {
      finalizePaypalTransaction: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  it("rejects when order ID has invalid characters and does not call service", async () => {
    await expect(
      controller.finalizePaypalTransaction("invalid!@#", user)
    ).rejects.toThrow();
    expect(paymentService.finalizePaypalTransaction).not.toHaveBeenCalled();
  });

  it("rejects when order ID is too short (< 5 chars)", async () => {
    await expect(
      controller.finalizePaypalTransaction("AB", user)
    ).rejects.toThrow();
  });

  it("rejects when order ID is too long (> 22 chars)", async () => {
    await expect(
      controller.finalizePaypalTransaction("ABCDEFGHIJKLMNOPQRSTUVWXYZ", user)
    ).rejects.toThrow();
  });

  it("calls service.finalizePaypalTransaction with valid order ID and delegates result", async () => {
    paymentService.finalizePaypalTransaction.mockResolvedValue({
      status: 200,
      message: "PayPal payment completed",
      captureId: "cap_123",
    });

    const result = await controller.finalizePaypalTransaction(
      "PAYPALORDER123",
      user
    );

    expect(paymentService.finalizePaypalTransaction).toHaveBeenCalledWith(
      "PAYPALORDER123",
      "user_789"
    );
    expect(result.status).toBe(200);
    expect(result.captureId).toBe("cap_123");
  });

  it("accepts minimum 5-character alphanumeric order ID", async () => {
    paymentService.finalizePaypalTransaction.mockResolvedValue({
      status: 200,
      message: "ok",
    });
    await controller.finalizePaypalTransaction("ABCD5", user);
    expect(paymentService.finalizePaypalTransaction).toHaveBeenCalledWith(
      "ABCD5",
      "user_789"
    );
  });

  it("accepts maximum 22-character alphanumeric order ID", async () => {
    const id22 = "ABCDEFGHIJKLMNOPQRSTUV";
    paymentService.finalizePaypalTransaction.mockResolvedValue({
      status: 200,
      message: "ok",
    });
    await controller.finalizePaypalTransaction(id22, user);
    expect(paymentService.finalizePaypalTransaction).toHaveBeenCalledWith(
      id22,
      "user_789"
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// getPaymentHistory (lines 218-219)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – getPaymentHistory", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<Pick<PaymentService, "getPaymentHistory">>;
  const user = { userId: "user_history" } as any;

  beforeEach(async () => {
    paymentService = {
      getPaymentHistory: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  it("calls service.getPaymentHistory with userId and query params", async () => {
    const query = { page: 1, limit: 10, status: "succeeded" } as any;
    const result = {
      success: true,
      data: [{ id: "pay_1", amount: 50000 }],
      meta: { totalItems: 1, totalPages: 1, currentPage: 1, itemsPerPage: 10 },
    };
    paymentService.getPaymentHistory.mockResolvedValue(result);

    const output = await controller.getPaymentHistory(user, query);

    expect(paymentService.getPaymentHistory).toHaveBeenCalledWith(
      "user_history",
      query
    );
    expect(output.data).toHaveLength(1);
  });

  it("works with default query when no params provided", async () => {
    const query = {} as any;
    paymentService.getPaymentHistory.mockResolvedValue({
      success: true,
      data: [],
      meta: { totalItems: 0 },
    });

    await controller.getPaymentHistory(user, query);

    expect(paymentService.getPaymentHistory).toHaveBeenCalledWith(
      "user_history",
      {}
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cancelPayment (line 229)
// ═══════════════════════════════════════════════════════════════════════════════

describe("PaymentController – cancelPayment", () => {
  let controller: PaymentController;
  let paymentService: jest.Mocked<
    Pick<PaymentService, "handlePaymentCancelled">
  >;
  const user = { userId: "user_cancel" } as any;

  beforeEach(async () => {
    paymentService = {
      handlePaymentCancelled: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PaymentController],
      providers: [
        { provide: PaymentService, useValue: paymentService },
        { provide: PaymentOpsService, useValue: makePaymentOpsService() },
      ],
    }).compile();

    controller = module.get<PaymentController>(PaymentController);
  });

  it("calls service.handlePaymentCancelled with userId and bookingCode", async () => {
    const dto = { bookingCode: "BK_CANCEL" } as any;
    paymentService.handlePaymentCancelled.mockResolvedValue({
      status: 200,
      message: "Payment cancelled successfully",
    });

    const result = await controller.cancelPayment(dto, user);

    expect(paymentService.handlePaymentCancelled).toHaveBeenCalledWith(
      "user_cancel",
      "BK_CANCEL"
    );
    expect(result.status).toBe(200);
  });

  it("returns void when service returns undefined (no-op for already cancelled)", async () => {
    const dto = { bookingCode: "BK_ALREADY_CANCELLED" } as any;
    paymentService.handlePaymentCancelled.mockResolvedValue(undefined);

    const result = await controller.cancelPayment(dto, user);

    expect(result).toBeUndefined();
  });
});
