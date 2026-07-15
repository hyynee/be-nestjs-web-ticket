import { of, throwError } from "rxjs";
import { MetricsInterceptor } from "./metrics.interceptor";
import { MetricsService } from "./metrics.service";

describe("MetricsInterceptor", () => {
  let interceptor: MetricsInterceptor;
  let metricsService: MetricsService;
  let endTimer: jest.Mock;

  const makeContext = (overrides: Record<string, any> = {}) =>
    ({
      switchToHttp: () => ({
        getRequest: () =>
          overrides.request ?? {
            method: "GET",
            path: "/api/test",
            route: { path: "/api/test" },
          },
        getResponse: () =>
          overrides.response ?? {
            statusCode: 200,
          },
      }),
    }) as any;

  beforeEach(async () => {
    endTimer = jest.fn();
    const startTimer = jest.fn().mockReturnValue(endTimer);
    metricsService = {
      httpRequestDuration: { startTimer },
    } as any;
    interceptor = new MetricsInterceptor(metricsService);
  });

  it("calls startTimer with method and route", async () => {
    const ctx = makeContext();
    const next = { handle: () => of("done") };

    await interceptor.intercept(ctx, next).toPromise();

    expect(metricsService.httpRequestDuration.startTimer).toHaveBeenCalledWith({
      method: "GET",
      route: "/api/test",
    });
  });

  it("ends the timer with status_code on success", async () => {
    const ctx = makeContext();
    const next = { handle: () => of("done") };

    await interceptor.intercept(ctx, next).toPromise();

    expect(endTimer).toHaveBeenCalledWith({ status_code: "200" });
  });

  it("ends the timer with status_code 500 on error when response has no status", async () => {
    const ctx = makeContext({
      response: {},
    });
    const next = { handle: () => throwError(() => new Error("fail")) };

    try {
      await interceptor.intercept(ctx, next).toPromise();
    } catch {
      // expected
    }

    expect(endTimer).toHaveBeenCalledWith({ status_code: "500" });
  });

  it("ends the timer with existing status_code on error", async () => {
    const ctx = makeContext({
      response: { statusCode: 400 },
    });
    const next = { handle: () => throwError(() => new Error("bad request")) };

    try {
      await interceptor.intercept(ctx, next).toPromise();
    } catch {
      // expected
    }

    expect(endTimer).toHaveBeenCalledWith({ status_code: "400" });
  });

  it("falls back to route path when req.route is missing", async () => {
    const ctx = makeContext({
      request: { method: "POST", path: "/no-route" },
    });
    const next = { handle: () => of("done") };

    await interceptor.intercept(ctx, next).toPromise();

    expect(metricsService.httpRequestDuration.startTimer).toHaveBeenCalledWith({
      method: "POST",
      route: "/no-route",
    });
  });

  it("uses UNKNOWN for missing method", async () => {
    const ctx = makeContext({
      request: { path: "/test", route: { path: "/test" } },
    });
    const next = { handle: () => of("done") };

    await interceptor.intercept(ctx, next).toPromise();

    expect(metricsService.httpRequestDuration.startTimer).toHaveBeenCalledWith({
      method: "UNKNOWN",
      route: "/test",
    });
  });

  it("returns next.handle() when context is not HTTP", async () => {
    const ctx = { switchToHttp: () => undefined } as any;
    const next = { handle: () => of("fallthrough") };

    const result = await interceptor.intercept(ctx, next).toPromise();

    expect(result).toBe("fallthrough");
  });

  it("falls back to unknown when both route and path are missing", async () => {
    const ctx = makeContext({
      request: { method: "DELETE" },
    });
    const next = { handle: () => of("done") };

    await interceptor.intercept(ctx, next).toPromise();

    expect(metricsService.httpRequestDuration.startTimer).toHaveBeenCalledWith({
      method: "DELETE",
      route: "unknown",
    });
  });
});
