import {
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";
import { PaymentWebhookStateService } from "./payment-webhook-state.service";

describe("PaymentWebhookStateService", () => {
  function makeService() {
    const repository = { updateStatus: jest.fn().mockResolvedValue(undefined) };
    const service = new PaymentWebhookStateService(repository as never);
    return { service, repository };
  }

  it("markProcessing sets status=processing and clears errorMessage", async () => {
    const { service, repository } = makeService();
    await service.markProcessing(PaymentWebhookProvider.STRIPE, "evt_1");
    expect(repository.updateStatus).toHaveBeenCalledWith(
      PaymentWebhookProvider.STRIPE,
      "evt_1",
      {
        $set: { status: PaymentWebhookEventStatus.PROCESSING },
        $unset: { errorMessage: "" },
      }
    );
  });

  it("markSucceeded sets status=succeeded with processedAt and clears errorMessage", async () => {
    const { service, repository } = makeService();
    await service.markSucceeded(PaymentWebhookProvider.STRIPE, "evt_1");
    const call = repository.updateStatus.mock.calls[0];
    expect(call[2].$set.status).toBe(PaymentWebhookEventStatus.SUCCEEDED);
    expect(call[2].$set.processedAt).toBeInstanceOf(Date);
    expect(call[2].$unset).toEqual({ errorMessage: "" });
  });

  it("markIgnored sets status=ignored with processedAt", async () => {
    const { service, repository } = makeService();
    await service.markIgnored(PaymentWebhookProvider.STRIPE, "evt_1");
    const call = repository.updateStatus.mock.calls[0];
    expect(call[2].$set.status).toBe(PaymentWebhookEventStatus.IGNORED);
  });

  it("markFailed sets status=failed with the error message and does NOT clear it", async () => {
    const { service, repository } = makeService();
    await service.markFailed(
      PaymentWebhookProvider.STRIPE,
      "evt_1",
      new Error("boom")
    );
    expect(repository.updateStatus).toHaveBeenCalledWith(
      PaymentWebhookProvider.STRIPE,
      "evt_1",
      {
        $set: {
          status: PaymentWebhookEventStatus.FAILED,
          errorMessage: "boom",
        },
      }
    );
  });

  it("markFailed handles a non-Error thrown value", async () => {
    const { service, repository } = makeService();
    await service.markFailed(
      PaymentWebhookProvider.STRIPE,
      "evt_1",
      "raw string"
    );
    const call = repository.updateStatus.mock.calls[0];
    expect(call[2].$set.errorMessage).toBe("unknown error");
  });
});
