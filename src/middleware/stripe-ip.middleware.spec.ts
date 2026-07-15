import { StripeIpMiddleware } from "./stripe-ip.middleware";
import { ForbiddenException, Logger } from "@nestjs/common";
import type { Request, Response } from "express";
import axios from "axios";

jest.mock("axios");

const makeReq = (ip: string): Request => ({ ip }) as unknown as Request;
const makeRes = (): Response => ({}) as Response;

const makeMockRedis = () => ({
  client: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue("OK"),
  },
});

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("StripeIpMiddleware", () => {
  let next: jest.Mock;

  beforeEach(() => {
    next = jest.fn();
    jest.resetModules();
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "log").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "debug").mockImplementation(() => {});
    // Prevent real HTTP calls during unit tests
    (axios.get as jest.Mock).mockRejectedValue(
      new Error("network disabled in tests")
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.STRIPE_IP_ALLOWLIST;
    delete process.env.NODE_ENV;
  });

  describe("disabled (development default)", () => {
    it("calls next() for any IP when allowlist is off", async () => {
      process.env.NODE_ENV = "development";
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await mw.use(makeReq("1.2.3.4"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("explicit STRIPE_IP_ALLOWLIST=false disables even in production", async () => {
      process.env.NODE_ENV = "production";
      process.env.STRIPE_IP_ALLOWLIST = "false";
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await mw.use(makeReq("1.2.3.4"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });
  });

  describe("enabled (production default)", () => {
    beforeEach(() => {
      process.env.NODE_ENV = "production";
    });

    it("allows known Stripe IPs (seed list)", async () => {
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      // 3.18.12.63 is in the hardcoded seed list
      await mw.use(makeReq("3.18.12.63"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("throws ForbiddenException for unknown IPs", async () => {
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await expect(
        mw.use(makeReq("192.168.1.99"), makeRes(), next)
      ).rejects.toThrow(ForbiddenException);
    });

    it("does not call next() for blocked IPs", async () => {
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await expect(
        mw.use(makeReq("10.0.0.1"), makeRes(), next)
      ).rejects.toThrow();
      expect(next).not.toHaveBeenCalled();
    });

    it("logs a warning when blocking a request", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await expect(
        mw.use(makeReq("99.99.99.99"), makeRes(), next)
      ).rejects.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("99.99.99.99")
      );
    });

    it("uses cached IPs from Redis when available", async () => {
      const mockRedis = makeMockRedis();
      mockRedis.client.get.mockResolvedValue(JSON.stringify(["1.2.3.4"]));
      const mw = new StripeIpMiddleware(mockRedis as any);
      await mw.refreshIps();
      await mw.use(makeReq("1.2.3.4"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("refreshes IPs from Stripe URL when Redis is empty", async () => {
      const testIps = ["5.5.5.5", "6.6.6.6", "7.7.7.7", "8.8.8.8", "9.9.9.9"];
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: testIps.join("\n"),
      });
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await mw.refreshIps();
      await mw.use(makeReq("5.5.5.5"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("rejects short IP list from Stripe URL (< 5 entries)", async () => {
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: "1.1.1.1\n2.2.2.2",
      });
      const loggerWarn = jest.spyOn(Logger.prototype, "warn");
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await mw.refreshIps();
      expect(loggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("Suspiciously short IP list")
      );
    });

    it("logs Redis set failure silently (catch handler)", async () => {
      const testIps = ["5.5.5.5", "6.6.6.6", "7.7.7.7", "8.8.8.8", "9.9.9.9"];
      (axios.get as jest.Mock).mockResolvedValueOnce({
        data: testIps.join("\n"),
      });
      const mockRedis = makeMockRedis();
      mockRedis.client.set.mockRejectedValueOnce(new Error("Redis OOM"));
      const mw = new StripeIpMiddleware(mockRedis as any);
      await expect(mw.refreshIps()).resolves.toBeUndefined();
    });

    it("logs warning when constructor warm-up refreshIps rejects", async () => {
      const warnSpy = jest.spyOn(Logger.prototype, "warn");
      jest
        .spyOn(StripeIpMiddleware.prototype, "refreshIps")
        .mockRejectedValue(new Error("unexpected failure"));
      new StripeIpMiddleware(makeMockRedis() as any);
      await Promise.resolve();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("initial IP refresh failed")
      );
    });

    it("handles refreshIps rejection during use() in catch handler", async () => {
      jest
        .spyOn(StripeIpMiddleware.prototype, "refreshIps")
        .mockRejectedValue(new Error("refresh failed"));
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await mw.use(makeReq("3.18.12.63"), makeRes(), next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("handles missing req.ip (falls back to empty string)", async () => {
      process.env.NODE_ENV = "production";
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      const reqWithoutIp = {} as Request;
      await expect(mw.use(reqWithoutIp, makeRes(), next)).rejects.toThrow(
        ForbiddenException
      );
    });
  });

  describe("explicit STRIPE_IP_ALLOWLIST=true", () => {
    it("enables allowlist even in development", async () => {
      process.env.NODE_ENV = "development";
      process.env.STRIPE_IP_ALLOWLIST = "true";
      const mw = new StripeIpMiddleware(makeMockRedis() as any);
      await expect(mw.use(makeReq("1.2.3.4"), makeRes(), next)).rejects.toThrow(
        ForbiddenException
      );
    });
  });
});
