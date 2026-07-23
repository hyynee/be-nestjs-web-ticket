import { Test, TestingModule } from "@nestjs/testing";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { HealthService } from "./health/health.service";
import { ConfigService } from "@nestjs/config";
import { MetricsService } from "./metrics/metrics.service";
import {
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";

describe("AppController", () => {
  let controller: AppController;
  let appService: Record<string, jest.Mock>;
  let healthService: Record<string, jest.Mock>;
  let configService: Record<string, jest.Mock>;
  let metricsService: Record<string, jest.Mock>;

  beforeEach(async () => {
    appService = {
      getHealth: jest.fn(),
      getInternalMetrics: jest.fn(),
    };

    healthService = {
      checkReadiness: jest.fn(),
    };

    configService = {
      get: jest.fn(),
    };

    metricsService = {
      getMetrics: jest.fn(),
      contentType: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        { provide: AppService, useValue: appService },
        { provide: HealthService, useValue: healthService },
        { provide: ConfigService, useValue: configService },
        { provide: MetricsService, useValue: metricsService },
      ],
    }).compile();

    controller = module.get<AppController>(AppController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("GET /health", () => {
    it("should return health status", () => {
      const healthResult = { status: "ok" };
      appService.getHealth.mockReturnValue(healthResult);

      const result = controller.health();

      expect(appService.getHealth).toHaveBeenCalled();
      expect(result).toEqual(healthResult);
    });
  });

  describe("GET /ready (legacy alias, delegates to HealthService)", () => {
    it("should return readiness when HealthService reports ready", async () => {
      const readinessResult = {
        status: "ready",
        checks: {
          mongodb: "ok",
          redisCache: "ok",
          redisSecurity: "ok",
          queue: "ok",
          config: "ok",
        },
      };
      healthService.checkReadiness.mockResolvedValue(readinessResult);

      const result = await controller.ready();

      expect(healthService.checkReadiness).toHaveBeenCalled();
      expect(result).toEqual(readinessResult);
    });

    it("should throw ServiceUnavailableException when HealthService reports unavailable", async () => {
      const readinessResult = {
        status: "unavailable",
        checks: {
          mongodb: "failed",
          redisCache: "ok",
          redisSecurity: "ok",
          queue: "ok",
          config: "ok",
        },
      };
      healthService.checkReadiness.mockResolvedValue(readinessResult);

      await expect(controller.ready()).rejects.toThrow(
        ServiceUnavailableException
      );
    });
  });

  describe("GET /internal/metrics", () => {
    const INTERNAL_SECRET = "secret123";

    it("should return internal metrics with valid secret", () => {
      configService.get.mockReturnValue(INTERNAL_SECRET);

      const metrics = {
        status: "ok",
        uptime: 100,
        memory: {
          heapUsedMb: 50,
          heapTotalMb: 100,
          rssMb: 80,
          externalMb: 10,
        },
        os: { freeMb: 1000, totalMb: 2000, loadAvg: [0.5] },
        version: "1.0.0",
      };
      appService.getInternalMetrics.mockReturnValue(metrics);

      const result = controller.internalMetrics(INTERNAL_SECRET);

      expect(configService.get).toHaveBeenCalledWith("INTERNAL_METRICS_SECRET");
      expect(appService.getInternalMetrics).toHaveBeenCalled();
      expect(result).toEqual(metrics);
    });

    it("should throw UnauthorizedException when secret is missing in config", () => {
      configService.get.mockReturnValue(undefined);

      expect(() => controller.internalMetrics(INTERNAL_SECRET)).toThrow(
        UnauthorizedException
      );
      expect(appService.getInternalMetrics).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException when secret does not match", () => {
      configService.get.mockReturnValue(INTERNAL_SECRET);

      expect(() => controller.internalMetrics("wrong-secret")).toThrow(
        UnauthorizedException
      );
      expect(appService.getInternalMetrics).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException when secret header is empty", () => {
      configService.get.mockReturnValue(INTERNAL_SECRET);

      expect(() => controller.internalMetrics("")).toThrow(
        UnauthorizedException
      );
      expect(appService.getInternalMetrics).not.toHaveBeenCalled();
    });
  });

  describe("GET /metrics", () => {
    const INTERNAL_SECRET = "secret123";

    const mockResponse = () => {
      const res: any = {};
      res.setHeader = jest.fn().mockReturnValue(res);
      res.send = jest.fn().mockReturnValue(res);
      return res;
    };

    it("should return prometheus metrics with valid secret", async () => {
      configService.get.mockReturnValue(INTERNAL_SECRET);

      const metricsData = "# HELP ...";
      metricsService.getMetrics.mockResolvedValue(metricsData);
      metricsService.contentType.mockReturnValue("text/plain; charset=utf-8");

      const res = mockResponse();
      await controller.prometheusMetrics(INTERNAL_SECRET, res);

      expect(configService.get).toHaveBeenCalledWith("INTERNAL_METRICS_SECRET");
      expect(metricsService.getMetrics).toHaveBeenCalled();
      expect(metricsService.contentType).toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "text/plain; charset=utf-8"
      );
      expect(res.send).toHaveBeenCalledWith(metricsData);
    });

    it("should throw UnauthorizedException when secret is missing in config", async () => {
      configService.get.mockReturnValue(undefined);

      const res = mockResponse();
      await expect(
        controller.prometheusMetrics(INTERNAL_SECRET, res)
      ).rejects.toThrow(UnauthorizedException);
      expect(metricsService.getMetrics).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException when secret does not match", async () => {
      configService.get.mockReturnValue(INTERNAL_SECRET);

      const res = mockResponse();
      await expect(
        controller.prometheusMetrics("wrong-secret", res)
      ).rejects.toThrow(UnauthorizedException);
      expect(metricsService.getMetrics).not.toHaveBeenCalled();
    });

    it("should throw UnauthorizedException when secret header is empty", async () => {
      configService.get.mockReturnValue(INTERNAL_SECRET);

      const res = mockResponse();
      await expect(controller.prometheusMetrics("", res)).rejects.toThrow(
        UnauthorizedException
      );
      expect(metricsService.getMetrics).not.toHaveBeenCalled();
    });
  });

  describe("decorator metadata branches", () => {
    it("handles non-function dependency types", () => {
      jest.isolateModules(() => {
        jest.mock("./app.service", () => ({}));
        jest.mock("./health/health.service", () => ({ HealthService: {} }));
        jest.mock("@nestjs/config", () => ({ ConfigService: {} }));
        jest.mock("./metrics/metrics.service", () => ({ MetricsService: {} }));

        const Ctrl = require("./app.controller").AppController;
        const ctrl = new Ctrl(
          {
            getHealth: jest.fn(),
            getInternalMetrics: jest.fn(),
          },
          { checkReadiness: jest.fn() },
          { get: jest.fn() },
          { getMetrics: jest.fn(), contentType: jest.fn() }
        );
        expect(ctrl.health()).toBeUndefined();
      });
    });
  });
});
