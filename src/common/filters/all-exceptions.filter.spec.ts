import { AllExceptionsFilter } from "./all-exceptions.filter";
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { ArgumentsHost } from "@nestjs/common";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeHost = (overrides: Record<string, unknown> = {}): ArgumentsHost => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  const req = {
    method: "POST",
    url: "/api/v1/auth/register",
    correlationId: "req-abc-123",
    headers: { "x-correlation-id": "req-abc-123" },
    ...overrides,
  };
  return {
    switchToHttp: () => ({
      getResponse: () => res,
      getRequest: () => req,
    }),
  } as unknown as ArgumentsHost;
};

const getResponseBody = (host: ArgumentsHost) => {
  const res = host.switchToHttp().getResponse();
  return (res.json as jest.Mock).mock.calls[0]?.[0];
};

const getStatusCode = (host: ArgumentsHost) => {
  const res = host.switchToHttp().getResponse();
  return (res.status as jest.Mock).mock.calls[0]?.[0];
};

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("AllExceptionsFilter", () => {
  let filter: AllExceptionsFilter;

  beforeEach(() => {
    filter = new AllExceptionsFilter();
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});
    jest.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  // ── HttpException: string message ─────────────────────────────────────────

  it("returns the string message from HttpException", () => {
    const host = makeHost();
    filter.catch(new HttpException("Custom error", 400), host);

    const body = getResponseBody(host);
    expect(body.message).toBe("Custom error");
    expect(body.statusCode).toBe(400);
    expect(body.success).toBe(false);
  });

  // ── THE KEY BUG FIX: ValidationPipe returns message as string[] ───────────

  it("preserves string[] from ValidationPipe — does NOT flatten to comma string", () => {
    const host = makeHost();
    const errors = ["email must be an email", "password is too short"];
    const exception = new BadRequestException({
      message: errors,
      statusCode: 400,
      error: "Bad Request",
    });

    filter.catch(exception, host);

    const body = getResponseBody(host);
    expect(Array.isArray(body.message)).toBe(true);
    expect(body.message).toEqual(errors);
    expect(body.statusCode).toBe(400);
  });

  it("returns a single string for scalar message field", () => {
    const host = makeHost();
    const exception = new BadRequestException({
      message: "single field error",
      statusCode: 400,
    });

    filter.catch(exception, host);

    const body = getResponseBody(host);
    expect(typeof body.message).toBe("string");
    expect(body.message).toBe("single field error");
  });

  it("falls back to exception.message when response has no message field", () => {
    const host = makeHost();
    const exception = new HttpException({ statusCode: 400 }, 400);

    filter.catch(exception, host);

    const body = getResponseBody(host);
    expect(typeof body.message).toBe("string");
  });

  // ── Non-HttpException (unhandled errors) ──────────────────────────────────

  it("returns 500 and 'Internal server error' for non-HttpException", () => {
    const host = makeHost();
    filter.catch(new Error("Database connection lost"), host);

    expect(getStatusCode(host)).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    const body = getResponseBody(host);
    expect(body.message).toBe("Internal server error");
    expect(body.success).toBe(false);
  });

  it("does NOT expose internal error message to client for non-HttpException", () => {
    const host = makeHost();
    filter.catch(new Error("SECRET connection string here"), host);

    const body = getResponseBody(host);
    expect(body.message).not.toContain("SECRET");
  });

  it("logs the real error server-side for non-HttpException", () => {
    const loggerSpy = jest.spyOn(Logger.prototype, "error");
    const host = makeHost();
    filter.catch(new Error("internal detail"), host);
    expect(loggerSpy).toHaveBeenCalled();
  });

  // ── Response shape ────────────────────────────────────────────────────────

  it("includes correlationId from request when present", () => {
    const host = makeHost({ correlationId: "my-trace-id" });
    filter.catch(new BadRequestException("oops"), host);

    const body = getResponseBody(host);
    expect(body.correlationId).toBe("my-trace-id");
  });

  it("omits correlationId when not set on request", () => {
    const host = makeHost({ correlationId: undefined, headers: {} });
    filter.catch(new BadRequestException("oops"), host);

    const body = getResponseBody(host);
    expect(body.correlationId).toBeUndefined();
  });

  it("always includes path and timestamp", () => {
    const host = makeHost();
    filter.catch(new BadRequestException("test"), host);

    const body = getResponseBody(host);
    expect(body.path).toBe("/api/v1/auth/register");
    expect(typeof body.timestamp).toBe("string");
  });

  // ── Non-Error thrown values ───────────────────────────────────────────────

  it("handles string thrown as exception without crashing", () => {
    const host = makeHost();
    expect(() => filter.catch("plain string error", host)).not.toThrow();
    expect(getStatusCode(host)).toBe(500);
  });

  it("handles null thrown as exception without crashing", () => {
    const host = makeHost();
    expect(() => filter.catch(null, host)).not.toThrow();
    expect(getStatusCode(host)).toBe(500);
  });

  // ── MongoDB transient errors → 503 ────────────────────────────────────────

  it("returns 503 for MongoNetworkError (primary failover)", () => {
    const host = makeHost();
    const err = Object.assign(new Error("connection lost"), {
      name: "MongoNetworkError",
    });
    filter.catch(err, host);
    expect(getStatusCode(host)).toBe(503);
    const body = getResponseBody(host);
    expect(body.message).toBe("Database temporarily unavailable, please retry");
  });

  it("returns 503 for MongoNetworkTimeoutError", () => {
    const host = makeHost();
    const err = Object.assign(new Error("timeout"), {
      name: "MongoNetworkTimeoutError",
    });
    filter.catch(err, host);
    expect(getStatusCode(host)).toBe(503);
  });

  it("returns 503 for MongoTopologyDestroyedError", () => {
    const host = makeHost();
    const err = Object.assign(new Error("topology destroyed"), {
      name: "MongoTopologyDestroyedError",
    });
    filter.catch(err, host);
    expect(getStatusCode(host)).toBe(503);
  });

  it("still returns 500 for generic MongoError (not network-related)", () => {
    const host = makeHost();
    const err = Object.assign(new Error("validation failed"), {
      name: "MongoServerError",
    });
    filter.catch(err, host);
    expect(getStatusCode(host)).toBe(500);
  });

  it("does NOT expose the MongoDB error message to the client on 503", () => {
    const host = makeHost();
    const err = Object.assign(new Error("secret connection string"), {
      name: "MongoNetworkError",
    });
    filter.catch(err, host);
    const body = getResponseBody(host);
    expect(body.message).not.toContain("secret");
  });

  it("logs 'no-id' for MongoDB transient error when correlationId is missing", () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error");
    const host = makeHost({ correlationId: undefined, headers: {} });
    const err = Object.assign(new Error("connection lost"), {
      name: "MongoNetworkError",
    });
    filter.catch(err, host);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[no-id]"));
  });

  it("returns 400 for Mongoose CastError on invalid ObjectId", () => {
    const host = makeHost();
    const err = Object.assign(new Error("Cast to ObjectId failed"), {
      name: "CastError",
      kind: "ObjectId",
    });
    filter.catch(err, host);
    expect(getStatusCode(host)).toBe(400);
    const body = getResponseBody(host);
    expect(body.message).toBe("Invalid ID format");
  });

  it("logs 'no-id' for unhandled exception when correlationId is missing", () => {
    const errorSpy = jest.spyOn(Logger.prototype, "error");
    const host = makeHost({ correlationId: undefined, headers: {} });
    filter.catch(new Error("some error"), host);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[no-id]"),
      expect.any(String)
    );
  });
});
