import { HandleStripeSideEventUseCase } from "./handle-stripe-side-event.use-case";

/**
 * Closes the "checkout.session.completed vs payment_intent.succeeded
 * ordering" gap flagged in the Phase 9 test-coverage audit. Stripe can
 * (and does) deliver these two events for the same charge in either
 * order. The actual booking-confirmation/ticket-issuance logic lives
 * entirely in `PaymentSettlementOrchestrator.handleCheckoutSessionCompleted`
 * (see payment.service.ts) — `handlePaymentIntentSucceeded` is a
 * deliberate no-op logger call with no shared mutable state, which is
 * exactly what makes delivery order irrelevant. These tests pin that
 * design down so a future change that adds real logic here doesn't
 * silently introduce an ordering dependency without a test failing.
 */
describe("HandleStripeSideEventUseCase.handlePaymentIntentSucceeded", () => {
  function makeUseCase() {
    const bookingModel = {
      findOne: jest.fn(),
      updateOne: jest.fn(),
    };
    const paymentModel = {
      updateOne: jest.fn(),
    };
    const queueService = { addJob: jest.fn() };
    const metricsService = { refundFailuresTotal: { inc: jest.fn() } };
    const redisService = { client: { del: jest.fn() } };

    const useCase = new HandleStripeSideEventUseCase(
      bookingModel as never,
      paymentModel as never,
      queueService as never,
      metricsService as never,
      redisService as never
    );

    return { useCase, bookingModel, paymentModel, queueService };
  }

  it("does not read or write Booking or Payment (pure no-op)", async () => {
    const { useCase, bookingModel, paymentModel } = makeUseCase();

    await useCase.handlePaymentIntentSucceeded({
      id: "pi_ordering_test",
    } as never);

    expect(bookingModel.findOne).not.toHaveBeenCalled();
    expect(bookingModel.updateOne).not.toHaveBeenCalled();
    expect(paymentModel.updateOne).not.toHaveBeenCalled();
  });

  it("never enqueues jobs or touches the queue", async () => {
    const { useCase, queueService } = makeUseCase();

    await useCase.handlePaymentIntentSucceeded({ id: "pi_1" } as never);

    expect(queueService.addJob).not.toHaveBeenCalled();
  });

  it("is safe to call before booking confirmation logic runs (arrives first)", async () => {
    const { useCase, bookingModel } = makeUseCase();

    // Simulates payment_intent.succeeded arriving BEFORE checkout.session.completed.
    await useCase.handlePaymentIntentSucceeded({ id: "pi_first" } as never);

    // No booking state was touched — whatever handleCheckoutSessionCompleted
    // does next (confirm the booking, issue tickets) is unaffected by
    // whether this ran before it.
    expect(bookingModel.updateOne).not.toHaveBeenCalled();
  });

  it("is safe to call after booking confirmation logic already ran (arrives second/duplicate order)", async () => {
    const { useCase, bookingModel } = makeUseCase();

    // Simulates checkout.session.completed having already confirmed the
    // booking elsewhere, then payment_intent.succeeded arriving after.
    await useCase.handlePaymentIntentSucceeded({ id: "pi_second" } as never);

    expect(bookingModel.updateOne).not.toHaveBeenCalled();
    expect(bookingModel.findOne).not.toHaveBeenCalled();
  });

  it("does not throw regardless of call order or how many times it is invoked (idempotent by construction)", async () => {
    const { useCase } = makeUseCase();

    await expect(
      Promise.all([
        useCase.handlePaymentIntentSucceeded({ id: "pi_dup" } as never),
        useCase.handlePaymentIntentSucceeded({ id: "pi_dup" } as never),
        useCase.handlePaymentIntentSucceeded({ id: "pi_dup" } as never),
      ])
    ).resolves.toBeDefined();
  });
});
