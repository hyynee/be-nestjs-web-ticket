import { Test, TestingModule } from "@nestjs/testing";
import { AppService } from "./app.service";

describe("AppService", () => {
  let service: AppService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AppService],
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
});
