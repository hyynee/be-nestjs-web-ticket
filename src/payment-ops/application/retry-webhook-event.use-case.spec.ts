import { ConflictException } from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditAction } from "@src/schemas/audit-log.schema";
import {
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";
import { RetryWebhookEventUseCase } from "./retry-webhook-event.use-case";

const admin: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};

function makeFailedRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    provider: PaymentWebhookProvider.STRIPE,
    eventId: "evt_123",
    eventType: "checkout.session.completed",
    status: PaymentWebhookEventStatus.FAILED,
    payload: { data: { object: {} } },
    retryCount: 1,
    ...overrides,
  };
}

describe("RetryWebhookEventUseCase", () => {
  function makeUseCase(overrides: {
    row?: ReturnType<typeof makeFailedRow>;
    dispatchResult?: boolean;
    dispatchError?: unknown;
  }) {
    const row = overrides.row ?? makeFailedRow();
    const repository = {
      loadById: jest.fn().mockResolvedValue(row),
      markRetrying: jest.fn().mockResolvedValue(undefined),
    };
    const dispatcher = {
      dispatchStripeEvent: overrides.dispatchError
        ? jest.fn().mockRejectedValue(overrides.dispatchError)
        : jest.fn().mockResolvedValue(overrides.dispatchResult ?? true),
    };
    const state = {
      markSucceeded: jest.fn().mockResolvedValue(undefined),
      markIgnored: jest.fn().mockResolvedValue(undefined),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    const queries = {
      findById: jest.fn().mockResolvedValue({ id: row._id.toString() }),
    };
    const paymentService = {
      markWebhookSucceeded: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };

    const useCase = new RetryWebhookEventUseCase(
      repository as never,
      dispatcher as never,
      state as never,
      queries as never,
      paymentService as never,
      auditService as never
    );

    return {
      useCase,
      repository,
      dispatcher,
      state,
      queries,
      paymentService,
      auditService,
      row,
    };
  }

  it("only allows retrying a FAILED webhook event", async () => {
    const { useCase, repository, row } = makeUseCase({
      row: makeFailedRow({ status: PaymentWebhookEventStatus.SUCCEEDED }),
    });

    await expect(useCase.execute(row._id.toString(), admin)).rejects.toThrow(
      ConflictException
    );
    expect(repository.markRetrying).not.toHaveBeenCalled();
  });

  it("marks retrying, dispatches, marks succeeded, and audits on a handled event", async () => {
    const {
      useCase,
      repository,
      dispatcher,
      state,
      paymentService,
      auditService,
      row,
    } = makeUseCase({ dispatchResult: true });

    await useCase.execute(row._id.toString(), admin);

    expect(repository.markRetrying).toHaveBeenCalledWith(row._id);
    expect(dispatcher.dispatchStripeEvent).toHaveBeenCalledWith(row);
    expect(state.markSucceeded).toHaveBeenCalledWith(row.provider, row.eventId);
    expect(state.markIgnored).not.toHaveBeenCalled();
    expect(paymentService.markWebhookSucceeded).toHaveBeenCalledWith(
      row.eventId
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: AuditAction.PAYMENT_WEBHOOK_RETRY })
    );
  });

  it("marks ignored (not succeeded) when the dispatcher reports the event type as unhandled", async () => {
    const { useCase, state, row } = makeUseCase({ dispatchResult: false });

    await useCase.execute(row._id.toString(), admin);

    expect(state.markIgnored).toHaveBeenCalledWith(row.provider, row.eventId);
    expect(state.markSucceeded).not.toHaveBeenCalled();
  });

  it("marks failed again and re-throws (does not swallow) when the dispatcher throws", async () => {
    const dispatchError = new Error("stripe processing error");
    const { useCase, state, auditService, row } = makeUseCase({
      dispatchError,
    });

    await expect(useCase.execute(row._id.toString(), admin)).rejects.toThrow(
      "stripe processing error"
    );
    expect(state.markFailed).toHaveBeenCalledWith(
      row.provider,
      row.eventId,
      dispatchError
    );
    // no audit record on a failed retry
    expect(auditService.record).not.toHaveBeenCalled();
  });

  it("returns the refreshed webhook event detail from the query service", async () => {
    const { useCase, queries, row } = makeUseCase({});

    const result = await useCase.execute(row._id.toString(), admin);

    expect(queries.findById).toHaveBeenCalledWith(row._id.toString());
    expect(result).toEqual({ event: { id: row._id.toString() } });
  });
});
