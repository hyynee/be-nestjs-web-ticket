import { Test, TestingModule } from "@nestjs/testing";
import { ServiceUnavailableException } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { HealthService } from "./health.service";

describe("HealthController", () => {
  let controller: HealthController;
  let healthService: jest.Mocked<HealthService>;

  beforeEach(async () => {
    healthService = {
      checkReadiness: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [{ provide: HealthService, useValue: healthService }],
    }).compile();

    controller = module.get<HealthController>(HealthController);
  });

  afterEach(() => jest.clearAllMocks());

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("GET /health/live", () => {
    it("should return status ok without touching any dependency", () => {
      const result = controller.live();
      expect(result).toEqual({ status: "ok" });
      expect(healthService.checkReadiness).not.toHaveBeenCalled();
    });
  });

  describe("GET /health/ready", () => {
    it("returns 200 with all checks ok when everything is healthy", async () => {
      healthService.checkReadiness.mockResolvedValue({
        status: "ready",
        checks: {
          mongodb: "ok",
          redisCache: "ok",
          redisSecurity: "ok",
          queue: "ok",
          config: "ok",
        },
      });

      const result = await controller.ready();
      expect(result.status).toBe("ready");
    });

    it("throws ServiceUnavailableException when any check fails", async () => {
      healthService.checkReadiness.mockResolvedValue({
        status: "unavailable",
        checks: {
          mongodb: "ok",
          redisCache: "failed",
          redisSecurity: "ok",
          queue: "ok",
          config: "ok",
        },
      });

      await expect(controller.ready()).rejects.toThrow(
        ServiceUnavailableException
      );
    });

    it("throws ServiceUnavailableException (maps to HTTP 503) when only redisSecurity fails — every authenticated request depends on it, so its outage alone must take readiness down", async () => {
      healthService.checkReadiness.mockResolvedValue({
        status: "unavailable",
        checks: {
          mongodb: "ok",
          redisCache: "ok",
          redisSecurity: "failed",
          queue: "ok",
          config: "ok",
        },
      });

      await expect(controller.ready()).rejects.toThrow(
        ServiceUnavailableException
      );
    });

    it("includes the per-dependency checks in the 503 response body", async () => {
      const readiness = {
        status: "unavailable" as const,
        checks: {
          mongodb: "ok" as const,
          redisCache: "failed" as const,
          redisSecurity: "ok" as const,
          queue: "ok" as const,
          config: "ok" as const,
        },
      };
      healthService.checkReadiness.mockResolvedValue(readiness);

      try {
        await controller.ready();
        fail("expected controller.ready() to throw");
      } catch (err) {
        expect((err as ServiceUnavailableException).getResponse()).toEqual(
          readiness
        );
      }
    });

    it("does not leak env secrets in the unavailable response", async () => {
      healthService.checkReadiness.mockResolvedValue({
        status: "unavailable",
        checks: {
          mongodb: "ok",
          redisCache: "ok",
          redisSecurity: "ok",
          queue: "ok",
          config: "failed",
        },
      });

      try {
        await controller.ready();
        fail("expected controller.ready() to throw");
      } catch (err) {
        const body = JSON.stringify(
          (err as ServiceUnavailableException).getResponse()
        );
        expect(body).not.toMatch(/sk_|whsec_|smtp|paypal/i);
      }
    });
  });
});
