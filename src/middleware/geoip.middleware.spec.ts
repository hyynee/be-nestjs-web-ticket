import { GeoIpMiddleware } from "./geoip.middleware";
import type { Request, Response } from "express";

jest.mock("geoip-lite", () => ({
  lookup: jest.fn(),
}));

import geoip from "geoip-lite";

describe("GeoIpMiddleware", () => {
  let middleware: GeoIpMiddleware;
  let next: jest.Mock;

  beforeEach(() => {
    middleware = new GeoIpMiddleware();
    next = jest.fn();
    (geoip.lookup as jest.Mock).mockReset();
  });

  const makeReq = (overrides: Record<string, any> = {}): Request =>
    ({
      headers: {},
      socket: {},
      ...overrides,
    }) as any;

  it("sets ipInfo with geoip lookup result", () => {
    (geoip.lookup as jest.Mock).mockReturnValue({
      city: "Hanoi",
      country: "VN",
    });
    const req = makeReq({
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    middleware.use(req, {} as Response, next);
    expect((req as any).ipInfo).toEqual(
      expect.objectContaining({ city: "Hanoi", country: "VN", ip: "1.2.3.4" })
    );
    expect(next).toHaveBeenCalled();
  });

  it("sets ipInfo to null when geoip returns nothing", () => {
    (geoip.lookup as jest.Mock).mockReturnValue(null);
    const req = makeReq({
      headers: { "x-forwarded-for": "10.0.0.1" },
    });
    middleware.use(req, {} as Response, next);
    expect((req as any).ipInfo).toBeNull();
  });

  it("handles IPv6 mapped IPv4 address", () => {
    (geoip.lookup as jest.Mock).mockReturnValue({ city: "Tokyo" });
    const req = makeReq({
      headers: { "x-forwarded-for": "::ffff:192.168.1.1" },
    });
    middleware.use(req, {} as Response, next);
    expect((req as any).ipInfo?.ip).toBe("192.168.1.1");
  });

  it("falls back to socket remoteAddress when x-forwarded-for is empty", () => {
    (geoip.lookup as jest.Mock).mockReturnValue({ city: "NYC" });
    const req = makeReq({
      socket: { remoteAddress: "10.0.0.1" },
    });
    middleware.use(req, {} as Response, next);
    expect((req as any).ipInfo?.ip).toBe("10.0.0.1");
  });

  it("sets ipInfo to null when geoip.lookup throws", () => {
    (geoip.lookup as jest.Mock).mockImplementation(() => {
      throw new Error("geoip error");
    });
    const req = makeReq({
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    middleware.use(req, {} as Response, next);
    expect((req as any).ipInfo).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it("handles empty ip when both x-forwarded-for and socket.remoteAddress are missing", () => {
    (geoip.lookup as jest.Mock).mockReturnValue(null);
    const req = makeReq({ headers: {}, socket: {} });
    middleware.use(req, {} as Response, next);
    expect((req as any).ipInfo).toBeNull();
    expect(next).toHaveBeenCalled();
  });
});
