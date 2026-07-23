import { PaymentWebhookProvider } from "@src/schemas/payment-webhook-event.schema";
import { PaymentWebhookQueryService } from "./payment-webhook-query.service";

describe("PaymentWebhookQueryService", () => {
  function makeService(rows: unknown[] = [], total = 0) {
    const repository = {
      findMany: jest.fn().mockResolvedValue({ rows, total }),
      loadById: jest.fn().mockResolvedValue({ id: "row-1" }),
    };
    const presenter = {
      toListItem: jest.fn((row: unknown) => ({
        ...(row as object),
        listItem: true,
      })),
      toDetail: jest.fn((row: unknown) => ({
        ...(row as object),
        detail: true,
      })),
    };
    const service = new PaymentWebhookQueryService(
      repository as never,
      presenter as never
    );
    return { service, repository, presenter };
  }

  it("builds a filter from provider/status/eventType and passes page/limit through", async () => {
    const { service, repository } = makeService();

    await service.findAll({
      provider: PaymentWebhookProvider.STRIPE,
      status: undefined,
      eventType: "checkout.session.completed",
      page: 2,
      limit: 10,
    } as never);

    expect(repository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: PaymentWebhookProvider.STRIPE,
        eventType: "checkout.session.completed",
      }),
      2,
      10
    );
  });

  it("adds a createdAt range filter when from/to are given", async () => {
    const { service, repository } = makeService();

    await service.findAll({
      from: "2026-01-01",
      to: "2026-01-31",
      page: 1,
      limit: 20,
    } as never);

    expect(repository.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        createdAt: {
          $gte: new Date("2026-01-01"),
          $lte: new Date("2026-01-31"),
        },
      }),
      1,
      20
    );
  });

  it("omits fields entirely absent from the query rather than filtering by undefined", async () => {
    const { service, repository } = makeService();

    await service.findAll({ page: 1, limit: 20 } as never);

    expect(repository.findMany).toHaveBeenCalledWith({}, 1, 20);
  });

  it("maps rows through the presenter and returns pagination metadata", async () => {
    const { service } = makeService([{ id: "a" }, { id: "b" }], 2);

    const result = await service.findAll({ page: 1, limit: 20 } as never);

    expect(result.items).toEqual([
      { id: "a", listItem: true },
      { id: "b", listItem: true },
    ]);
    expect(result.total).toBe(2);
  });

  it("findById delegates to the repository and presenter detail mapping", async () => {
    const { service, repository, presenter } = makeService();

    const result = await service.findById("row-1");

    expect(repository.loadById).toHaveBeenCalledWith("row-1");
    expect(presenter.toDetail).toHaveBeenCalledWith({ id: "row-1" });
    expect(result).toEqual({ id: "row-1", detail: true });
  });
});
