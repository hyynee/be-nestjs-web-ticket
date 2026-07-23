import { BadRequestException } from "@nestjs/common";
import { PaymentWebhookProvider } from "@src/schemas/payment-webhook-event.schema";
import { PaymentWebhookDispatcherService } from "./payment-webhook-dispatcher.service";

function makeRow(eventType: string, provider = PaymentWebhookProvider.STRIPE) {
  return {
    provider,
    eventType,
    payload: { data: { object: { id: "obj_1" } } },
  };
}

describe("PaymentWebhookDispatcherService", () => {
  function makeDispatcher() {
    const paymentService = {
      handlePaymentIntentSucceeded: jest.fn().mockResolvedValue(undefined),
      handleCheckoutSessionCompleted: jest.fn().mockResolvedValue(undefined),
      handleChargeRefunded: jest.fn().mockResolvedValue(undefined),
      handlePaymentIntentFailed: jest.fn().mockResolvedValue(undefined),
      handleChargeDisputeCreated: jest.fn().mockResolvedValue(undefined),
      handlePaymentIntentCanceled: jest.fn().mockResolvedValue(undefined),
      handleCheckoutSessionExpired: jest.fn().mockResolvedValue(undefined),
    };
    const dispatcher = new PaymentWebhookDispatcherService(
      paymentService as never
    );
    return { dispatcher, paymentService };
  }

  const routingCases: Array<
    [string, keyof ReturnType<typeof makeDispatcher>["paymentService"]]
  > = [
    ["payment_intent.succeeded", "handlePaymentIntentSucceeded"],
    ["checkout.session.completed", "handleCheckoutSessionCompleted"],
    ["charge.refunded", "handleChargeRefunded"],
    ["payment_intent.payment_failed", "handlePaymentIntentFailed"],
    ["charge.dispute.created", "handleChargeDisputeCreated"],
    ["payment_intent.canceled", "handlePaymentIntentCanceled"],
    ["checkout.session.expired", "handleCheckoutSessionExpired"],
  ];

  it.each(routingCases)(
    "routes %s to PaymentService.%s and returns true",
    async (eventType, handlerName) => {
      const { dispatcher, paymentService } = makeDispatcher();
      const row = makeRow(eventType);

      const handled = await dispatcher.dispatchStripeEvent(row as never);

      expect(handled).toBe(true);
      expect(paymentService[handlerName]).toHaveBeenCalledWith(
        row.payload.data.object
      );
    }
  );

  it("returns false (does not throw) for an unrecognized event type", async () => {
    const { dispatcher, paymentService } = makeDispatcher();
    const row = makeRow("some.unhandled.event");

    const handled = await dispatcher.dispatchStripeEvent(row as never);

    expect(handled).toBe(false);
    Object.values(paymentService).forEach((fn) =>
      expect(fn).not.toHaveBeenCalled()
    );
  });

  it("rejects a non-Stripe provider row", async () => {
    const { dispatcher } = makeDispatcher();
    const row = makeRow(
      "payment_intent.succeeded",
      PaymentWebhookProvider.PAYPAL
    );

    await expect(dispatcher.dispatchStripeEvent(row as never)).rejects.toThrow(
      BadRequestException
    );
  });

  it("rejects a payload missing data.object", async () => {
    const { dispatcher } = makeDispatcher();
    const row = {
      provider: PaymentWebhookProvider.STRIPE,
      eventType: "payment_intent.succeeded",
      payload: {},
    };

    await expect(dispatcher.dispatchStripeEvent(row as never)).rejects.toThrow(
      BadRequestException
    );
  });
});
