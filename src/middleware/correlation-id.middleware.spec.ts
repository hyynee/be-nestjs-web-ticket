import {
  CorrelationIdMiddleware,
  CORRELATION_ID_HEADER,
} from "./correlation-id.middleware";
import type { Request, Response, NextFunction } from "express";

type ExtendedReq = Request & { correlationId?: string };

const makeReq = (headers: Record<string, string> = {}): ExtendedReq =>
  ({ headers }) as unknown as ExtendedReq;
const makeRes = (): Response =>
  ({ setHeader: jest.fn() }) as unknown as Response;
const next: NextFunction = jest.fn();

describe("CorrelationIdMiddleware", () => {
  let mw: CorrelationIdMiddleware;

  beforeEach(() => {
    mw = new CorrelationIdMiddleware();
    (next as jest.Mock).mockClear();
  });

  it("propagates an existing correlation-id header onto req.correlationId", () => {
    const req = makeReq({ [CORRELATION_ID_HEADER]: "existing-id-123" });
    mw.use(req, makeRes(), next);
    expect(req.correlationId).toBe("existing-id-123");
  });

  it("generates a new UUID when no correlation-id header is present", () => {
    const req = makeReq();
    mw.use(req, makeRes(), next);
    expect(typeof req.correlationId).toBe("string");
    expect(req.correlationId!.length).toBeGreaterThan(0);
  });

  it("always calls next()", () => {
    mw.use(makeReq(), makeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("generates unique IDs for different requests", () => {
    const req1 = makeReq();
    const req2 = makeReq();
    mw.use(req1, makeRes(), next);
    mw.use(req2, makeRes(), next);
    expect(req1.correlationId).not.toBe(req2.correlationId);
  });
});
