import { PaymentWebhookProvider } from "@src/schemas/payment-webhook-event.schema";
import { PaymentWebhookRecorderService } from "./payment-webhook-recorder.service";

function makeStripeEvent(id = "evt_1") {
  return { id, type: "checkout.session.completed", data: {} } as never;
}

describe("PaymentWebhookRecorderService", () => {
  function makeService(overrides: {
    upsertResult?: unknown;
    upsertError?: unknown;
    existing?: unknown;
  }) {
    const upsertResult =
      "upsertResult" in overrides ? overrides.upsertResult : { id: "row-1" };
    const repository = {
      upsertReceivedStripeEvent: overrides.upsertError
        ? jest.fn().mockRejectedValue(overrides.upsertError)
        : jest.fn().mockResolvedValue(upsertResult),
      findByProviderEvent: jest
        .fn()
        .mockResolvedValue("existing" in overrides ? overrides.existing : null),
    };
    const presenter = {
      toDetail: jest.fn((row: unknown) => ({
        ...(row as object),
        presented: true,
      })),
    };
    const service = new PaymentWebhookRecorderService(
      repository as never,
      presenter as never
    );
    return { service, repository, presenter };
  }

  it("persists a newly-received event on the first delivery", async () => {
    const { service, repository, presenter } = makeService({
      upsertResult: { id: "row-1" },
    });

    const result = await service.recordReceivedStripeEvent(makeStripeEvent());

    expect(repository.upsertReceivedStripeEvent).toHaveBeenCalled();
    expect(presenter.toDetail).toHaveBeenCalledWith({ id: "row-1" });
    expect(result).toEqual({ id: "row-1", presented: true });
  });

  it("returns the already-existing row when a duplicate delivery loses the upsert race (returns null) but the row exists", async () => {
    const { service, repository } = makeService({
      upsertResult: null,
      existing: { id: "row-1" },
    });

    const result = await service.recordReceivedStripeEvent(makeStripeEvent());

    expect(repository.findByProviderEvent).toHaveBeenCalledWith(
      PaymentWebhookProvider.STRIPE,
      "evt_1"
    );
    expect(result).toEqual({ id: "row-1", presented: true });
  });

  it("throws when the upsert returns null and no existing row can be found (should not happen, but must not silently succeed)", async () => {
    const { service } = makeService({ upsertResult: null, existing: null });

    await expect(
      service.recordReceivedStripeEvent(makeStripeEvent())
    ).rejects.toThrow("Stripe webhook event was not persisted");
  });

  it("falls back to the existing row when the DB throws a real duplicate-key error (E11000) under concurrent delivery", async () => {
    const { service, repository } = makeService({
      upsertError: { code: 11000 },
      existing: { id: "row-1" },
    });

    const result = await service.recordReceivedStripeEvent(makeStripeEvent());

    expect(repository.findByProviderEvent).toHaveBeenCalled();
    expect(result).toEqual({ id: "row-1", presented: true });
  });

  it("re-throws a duplicate-key error if the existing row still can't be found", async () => {
    const dupError = { code: 11000 };
    const { service } = makeService({
      upsertError: dupError,
      existing: null,
    });

    await expect(
      service.recordReceivedStripeEvent(makeStripeEvent())
    ).rejects.toBe(dupError);
  });

  it("re-throws non-duplicate-key errors unchanged", async () => {
    const { service } = makeService({ upsertError: new Error("db down") });

    await expect(
      service.recordReceivedStripeEvent(makeStripeEvent())
    ).rejects.toThrow("db down");
  });
});
