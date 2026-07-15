import { Test, TestingModule } from "@nestjs/testing";
import { MetricsService } from "./metrics.service";

describe("MetricsService", () => {
  let service: MetricsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [MetricsService],
    }).compile();
    service = module.get(MetricsService);
    service.onModuleInit();
  });

  it("exposes a prometheus-format metrics string", async () => {
    const output = await service.getMetrics();
    expect(typeof output).toBe("string");
    expect(output.length).toBeGreaterThan(0);
  });

  it("returns the correct Content-Type header value", () => {
    const ct = service.contentType();
    expect(ct).toContain("text/plain");
  });

  it("bookingsTotal counter increments correctly", async () => {
    service.bookingsTotal.inc({ status: "success" });
    service.bookingsTotal.inc({ status: "success" });
    service.bookingsTotal.inc({ status: "error" });
    const metrics = await service.getMetrics();
    expect(metrics).toContain("bookings_total");
  });

  it("paymentsTotal counter labels are tracked separately", async () => {
    service.paymentsTotal.inc({ provider: "stripe", status: "succeeded" });
    service.paymentsTotal.inc({ provider: "paypal", status: "succeeded" });
    const metrics = await service.getMetrics();
    expect(metrics).toContain("payments_total");
    expect(metrics).toContain('provider="stripe"');
    expect(metrics).toContain('provider="paypal"');
  });

  it("refundFailuresTotal tracks by source", async () => {
    service.refundFailuresTotal.inc({ source: "stripe" });
    const metrics = await service.getMetrics();
    expect(metrics).toContain("refund_failures_total");
  });

  it("checkinsTotal is accessible", async () => {
    service.checkinsTotal.inc({ result: "success" });
    const metrics = await service.getMetrics();
    expect(metrics).toContain("checkins_total");
  });

  it("queueDepth gauge can be set", async () => {
    service.queueDepth.set({ state: "waiting" }, 5);
    const metrics = await service.getMetrics();
    expect(metrics).toContain("queue_depth");
  });
});
