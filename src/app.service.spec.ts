import { Test, TestingModule } from "@nestjs/testing";
import { getConnectionToken } from "@nestjs/mongoose";
import { AppService } from "./app.service";
import { RedisService } from "./redis/redis.service";
import { QueueService } from "./queue/queue.service";

describe("AppService", () => {
  let service: AppService;
  let mongoConnection: any;
  let redisService: any;
  let queueService: any;

  beforeEach(async () => {
    mongoConnection = { readyState: 1 };
    redisService = { client: { isOpen: true } };
    queueService = {
      getJobCounts: jest.fn().mockResolvedValue({
        active: 2,
        waiting: 1,
        failed: 0,
        delayed: 0,
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AppService,
        { provide: getConnectionToken(), useValue: mongoConnection },
        { provide: RedisService, useValue: redisService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get<AppService>(AppService);
  });

  // ── getHealth ─────────────────────────────────────────────────────────────

  describe("getHealth", () => {
    it("returns status: ok", () => {
      const result = service.getHealth();
      expect(result).toEqual({ status: "ok" });
    });

    it("does NOT expose heap, OS or Node version (info disclosure fix)", () => {
      const result = service.getHealth() as Record<string, unknown>;
      expect(result.memory).toBeUndefined();
      expect(result.os).toBeUndefined();
      expect(result.nodeVersion).toBeUndefined();
    });
  });

  // ── getInternalMetrics ────────────────────────────────────────────────────

  describe("getInternalMetrics", () => {
    it("returns status and memory fields", () => {
      const result = service.getInternalMetrics() as Record<string, unknown>;
      expect(result.status).toBe("ok");
      expect(result.memory).toBeDefined();
      expect(result.uptime).toBeDefined();
    });

    it("returns numeric heap values", () => {
      const { memory } = service.getInternalMetrics() as {
        memory: { heapUsedMb: number; heapTotalMb: number };
      };
      expect(typeof memory.heapUsedMb).toBe("number");
      expect(memory.heapUsedMb).toBeGreaterThan(0);
    });

    it("returns version as unknown when npm_package_version is deleted", () => {
      const orig = process.env.npm_package_version;
      delete process.env.npm_package_version;
      const result = service.getInternalMetrics();
      expect(result.version).toBe("unknown");
      process.env.npm_package_version = orig;
    });
  });

  describe("decorator metadata branches", () => {
    it("handles non-function dependency types", () => {
      jest.isolateModules(() => {
        jest.mock("mongoose", () => ({
          createConnection: jest.fn(),
          connect: jest.fn(),
        }));
        jest.mock("@nestjs/mongoose", () => ({
          InjectConnection: () => jest.fn(),
          getConnectionToken: () => "MongoConnection",
        }));
        jest.mock("./redis/redis.service", () => ({}));
        jest.mock("./queue/queue.service", () => ({}));

        const { AppService: Svc } = require("./app.service");
        const s = new Svc({ readyState: 1 } as any, {} as any, {} as any);
        expect(s).toBeDefined();
      });
    });
  });

  // ── getReadiness ──────────────────────────────────────────────────────────

  describe("getReadiness", () => {
    it("returns ready when both MongoDB and Redis are up", async () => {
      const result = await service.getReadiness();
      expect(result.status).toBe("ready");
      expect(result.dependencies.mongodb).toBe("up");
      expect(result.dependencies.redis).toBe("up");
    });

    it("includes queue counts in the response", async () => {
      const result = await service.getReadiness();
      expect(result.queue.active).toBe(2);
      expect(result.queue.waiting).toBe(1);
    });

    it("returns not_ready when MongoDB is disconnected", async () => {
      mongoConnection.readyState = 0;
      const result = await service.getReadiness();
      expect(result.status).toBe("not_ready");
      expect(result.dependencies.mongodb).toBe("down");
    });

    it("returns not_ready when Redis is closed", async () => {
      redisService.client.isOpen = false;
      const result = await service.getReadiness();
      expect(result.status).toBe("not_ready");
      expect(result.dependencies.redis).toBe("down");
    });

    it("returns not_ready when Redis client is null", async () => {
      redisService.client = null;
      const result = await service.getReadiness();
      expect(result.status).toBe("not_ready");
      expect(result.dependencies.redis).toBe("down");
    });

    it("returns not_ready when Redis service is null", async () => {
      (service as any).redisService = null;
      const result = await service.getReadiness();
      expect(result.status).toBe("not_ready");
      expect(result.dependencies.redis).toBe("down");
    });

    it("does not fail when queue metric fetch throws", async () => {
      queueService.getJobCounts.mockRejectedValue(
        new Error("BullMQ unavailable")
      );
      const result = await service.getReadiness();
      expect(result.status).toBe("ready");
      expect(result.queue).toBeDefined();
    });

    it("returns not_ready when outer try block throws (e.g. mongo crashes mid-read)", async () => {
      Object.defineProperty(mongoConnection, "readyState", {
        get: () => {
          throw new Error("Mongo crash");
        },
        configurable: true,
      });
      const result = await service.getReadiness();
      expect(result.status).toBe("not_ready");
      expect(result.dependencies.mongodb).toBe("down");
    });
  });
});
