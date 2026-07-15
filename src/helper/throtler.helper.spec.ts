import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ThrottlerException } from "@nestjs/throttler";
import { CustomThrottlerGuard } from "./throtler.helper";

function makeGuard(): CustomThrottlerGuard {
  return Object.create(CustomThrottlerGuard.prototype) as CustomThrottlerGuard;
}

function createRealGuard(): CustomThrottlerGuard {
  const options = [{ limit: 10, ttl: 60 }];
  const storage = { increment: jest.fn() };
  const reflector = new Reflector();
  return new CustomThrottlerGuard(options as any, storage as any, reflector);
}

describe("CustomThrottlerGuard", () => {
  describe("getTracker", () => {
    let guard: CustomThrottlerGuard;

    beforeEach(() => {
      guard = makeGuard();
    });

    it("tracks by userId when user is authenticated", async () => {
      const tracker = await (guard as any).getTracker({
        user: { userId: "123" },
        ip: "10.0.0.1",
      });
      expect(tracker).toBe("user:123");
    });

    it("tracks by ip when user is not authenticated", async () => {
      const tracker = await (guard as any).getTracker({
        ip: "10.0.0.1",
      });
      expect(tracker).toBe("10.0.0.1");
    });

    it("tracks as unknown when neither user nor ip is present", async () => {
      const tracker = await (guard as any).getTracker({});
      expect(tracker).toBe("unknown");
    });
  });

  describe("canActivate — fail-open on Redis errors", () => {
    let guard: CustomThrottlerGuard;

    beforeEach(() => {
      guard = makeGuard();
      (guard as any).throttlerLogger = { error: jest.fn() };
    });

    it("re-throws ThrottlerException (legitimate rate limit)", async () => {
      const ctx = {} as ExecutionContext;
      jest
        .spyOn(
          Object.getPrototypeOf(Object.getPrototypeOf(guard)),
          "canActivate"
        )
        .mockRejectedValueOnce(new ThrottlerException());

      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ThrottlerException
      );
    });

    it("returns true (fail-open) when Redis storage throws a generic error", async () => {
      const ctx = {} as ExecutionContext;
      jest
        .spyOn(
          Object.getPrototypeOf(Object.getPrototypeOf(guard)),
          "canActivate"
        )
        .mockRejectedValueOnce(new Error("Redis connection refused"));

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it("returns true (fail-open) when error has no message property", async () => {
      const ctx = {} as ExecutionContext;
      jest
        .spyOn(
          Object.getPrototypeOf(Object.getPrototypeOf(guard)),
          "canActivate"
        )
        .mockRejectedValueOnce({ name: "UnknownError" });

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it("returns true when super.canActivate returns true", async () => {
      const ctx = {} as ExecutionContext;
      jest
        .spyOn(
          Object.getPrototypeOf(Object.getPrototypeOf(guard)),
          "canActivate"
        )
        .mockResolvedValueOnce(true);

      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  describe("real constructor instantiation", () => {
    it("creates an instance via new and covers Logger initialization", () => {
      const guard = createRealGuard();
      expect(guard).toBeDefined();
    });
  });
});
