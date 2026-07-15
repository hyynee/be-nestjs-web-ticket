import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Logger } from "@nestjs/common";
import { PaymentScheduler } from "./payment.scheduler";
import { Payment } from "@src/schemas/payment.schema";
import { PaymentService } from "./payment.service";
import { RedisService } from "@src/redis/redis.service";
import { TicketService } from "@src/ticket/ticket.service";
import { MailService } from "@src/services/mail.service";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { UserEventsService } from "@src/events/user-event.services";
import { QueueService } from "@src/queue/queue.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { CurrencyService } from "@src/currency/currency.service";

jest.mock("stripe", () => jest.fn().mockImplementation(() => ({})));
jest.mock("@paypal/checkout-server-sdk", () => ({
  core: {
    SandboxEnvironment: jest.fn(),
    LiveEnvironment: jest.fn(),
    PayPalHttpClient: jest.fn(),
  },
  orders: { OrdersCreateRequest: jest.fn(), OrdersCaptureRequest: jest.fn() },
  payments: { CapturesRefundRequest: jest.fn() },
}));
jest.mock("@src/config/config", () => ({
  default: {
    STRIPE_SECRET_KEY: "sk_test",
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    FRONTEND_URL: "http://localhost:3000",
  },
}));

describe("PaymentScheduler", () => {
  let scheduler: PaymentScheduler;
  let redisClient: any;
  let paymentModel: any;
  let paymentService: any;

  beforeEach(async () => {
    redisClient = {
      set: jest.fn().mockResolvedValue(null),
      eval: jest.fn().mockResolvedValue(1),
    };

    paymentModel = {
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue([]),
          }),
        }),
      }),
    };

    paymentService = {
      finalizePaypalTransaction: jest.fn().mockResolvedValue(undefined),
    };

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PaymentScheduler,
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: PaymentService, useValue: paymentService },
        { provide: RedisService, useValue: { client: redisClient } },
        { provide: getModelToken("Booking"), useValue: {} },
        { provide: getModelToken("Zone"), useValue: {} },
        { provide: getModelToken("Ticket"), useValue: {} },
        { provide: TicketService, useValue: {} },
        { provide: MailService, useValue: {} },
        { provide: ZoneGateway, useValue: {} },
        { provide: UserEventsService, useValue: {} },
        { provide: QueueService, useValue: { addJob: jest.fn() } },
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

    scheduler = module.get(PaymentScheduler);
  });

  afterEach(() => jest.restoreAllMocks());

  it("exits early when lock cannot be acquired", async () => {
    redisClient.set.mockResolvedValue(null);
    await scheduler.reconcilePendingPaypalOrders();
    expect(paymentModel.find).not.toHaveBeenCalled();
  });

  it("calls finalizePaypalTransaction for each pending payment when lock acquired", async () => {
    redisClient.set.mockResolvedValue("OK");
    paymentModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            { _id: "p1", paypalOrderId: "ORDER1", userId: "u1" },
            { _id: "p2", paypalOrderId: "ORDER2", userId: "u2" },
          ]),
        }),
      }),
    });

    await scheduler.reconcilePendingPaypalOrders();

    expect(paymentService.finalizePaypalTransaction).toHaveBeenCalledTimes(2);
    expect(paymentService.finalizePaypalTransaction).toHaveBeenCalledWith(
      "ORDER1",
      "u1"
    );
    expect(paymentService.finalizePaypalTransaction).toHaveBeenCalledWith(
      "ORDER2",
      "u2"
    );
  });

  it("handles lock acquire failure gracefully", async () => {
    redisClient.set.mockRejectedValue(new Error("Redis down"));
    await scheduler.reconcilePendingPaypalOrders();
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("paypal-reconcile: lock acquire failed")
    );
  });

  it("handles payment service errors gracefully per payment", async () => {
    redisClient.set.mockResolvedValue("OK");
    paymentModel.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        limit: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue([
              { _id: "p1", paypalOrderId: "ORDER_FAIL", userId: "u1" },
            ]),
        }),
      }),
    });

    paymentService.finalizePaypalTransaction.mockRejectedValue(
      new Error("Already finalized")
    );

    await scheduler.reconcilePendingPaypalOrders();

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("paypal-reconcile: orderId=ORDER_FAIL")
    );
  });
});
