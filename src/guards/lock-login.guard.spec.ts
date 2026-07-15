import { HttpException } from "@nestjs/common";
import { LockLoginGuard } from "./lock-login.guard";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { ExecutionContext } from "@nestjs/common";

const makeCtx = (
  body: Record<string, unknown> = {},
  ip = "127.0.0.1"
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ body, ip }),
    }),
  }) as unknown as ExecutionContext;

describe("LockLoginGuard", () => {
  let guard: LockLoginGuard;
  let loginService: jest.Mocked<Pick<LockLoginService, "isLocked">>;

  beforeEach(() => {
    loginService = { isLocked: jest.fn().mockResolvedValue(false) };
    guard = new LockLoginGuard(loginService as unknown as LockLoginService);
  });

  it("allows request when account is not locked", async () => {
    loginService.isLocked.mockResolvedValue(false);
    await expect(
      guard.canActivate(makeCtx({ email: "user@example.com" }))
    ).resolves.toBe(true);
  });

  it("throws 423 when account is locked", async () => {
    loginService.isLocked.mockResolvedValue(true);
    await expect(
      guard.canActivate(makeCtx({ email: "user@example.com" }))
    ).rejects.toThrow(HttpException);
  });

  it("allows through when email is missing from body", async () => {
    await expect(guard.canActivate(makeCtx({}))).resolves.toBe(true);
    expect(loginService.isLocked).not.toHaveBeenCalled();
  });

  it("allows through when email is not a string", async () => {
    await expect(guard.canActivate(makeCtx({ email: 12345 }))).resolves.toBe(
      true
    );
    expect(loginService.isLocked).not.toHaveBeenCalled();
  });

  it("allows through for empty string email", async () => {
    await expect(guard.canActivate(makeCtx({ email: "   " }))).resolves.toBe(
      true
    );
    expect(loginService.isLocked).not.toHaveBeenCalled();
  });

  it("calls isLocked with normalized (lowercased + trimmed) email", async () => {
    await guard.canActivate(
      makeCtx({ email: "  User@Example.COM  " }, "10.0.0.1")
    );
    expect(loginService.isLocked).toHaveBeenCalledWith(
      "user@example.com",
      "10.0.0.1"
    );
  });

  it("falls back to socket remoteAddress when request.ip is missing", async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          body: { email: "test@test.com" },
          ip: undefined,
          socket: { remoteAddress: "192.168.1.50" },
        }),
      }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect(loginService.isLocked).toHaveBeenCalledWith(
      "test@test.com",
      "192.168.1.50"
    );
  });

  it("falls back to 'unknown' when neither ip nor socket.remoteAddress is present", async () => {
    loginService.isLocked.mockResolvedValue(true);
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          body: { email: "user@example.com" },
          ip: undefined,
          socket: undefined,
        }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).rejects.toThrow(HttpException);
    expect(loginService.isLocked).toHaveBeenCalledWith(
      "user@example.com",
      "unknown"
    );
  });

  it("falls back to 'unknown' when socket.remoteAddress is empty string", async () => {
    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          body: { email: "test@test.com" },
          ip: undefined,
          socket: { remoteAddress: "" },
        }),
      }),
    } as unknown as ExecutionContext;

    await guard.canActivate(ctx);
    expect(loginService.isLocked).toHaveBeenCalledWith(
      "test@test.com",
      "unknown"
    );
  });
});
