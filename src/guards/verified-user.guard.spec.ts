import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { VerifiedUserGuard } from "./verified-user.guard";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeContext = (user?: { isVerified?: boolean }): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user }),
    }),
  }) as unknown as ExecutionContext;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("VerifiedUserGuard", () => {
  let guard: VerifiedUserGuard;

  beforeEach(() => {
    guard = new VerifiedUserGuard();
  });

  it("allows the request when the user is verified", () => {
    expect(guard.canActivate(makeContext({ isVerified: true }))).toBe(true);
  });

  it("throws ForbiddenException when the user is not verified", () => {
    expect(() => guard.canActivate(makeContext({ isVerified: false }))).toThrow(
      ForbiddenException
    );
  });

  it("throws ForbiddenException when isVerified is missing on the user", () => {
    expect(() => guard.canActivate(makeContext({}))).toThrow(
      ForbiddenException
    );
  });

  it("throws ForbiddenException when there is no user on the request (unauthenticated)", () => {
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException
    );
  });
});
