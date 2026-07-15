import { RolesGuard } from "./role.guard";
import { Reflector } from "@nestjs/core";
import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";

// ── Helpers ───────────────────────────────────────────────────────────────────

const makeContext = (role?: string): ExecutionContext =>
  ({
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({ user: role !== undefined ? { role } : undefined }),
    }),
  }) as unknown as ExecutionContext;

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("RolesGuard", () => {
  let reflector: Reflector;
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = new Reflector();
    jest.spyOn(reflector, "getAllAndOverride");
    guard = new RolesGuard(reflector);
  });

  afterEach(() => jest.restoreAllMocks());

  // ── Role matches ──────────────────────────────────────────────────────────

  it("allows when metadata roles match user role", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
    expect(guard.canActivate(makeContext("admin"))).toBe(true);
  });

  it("allows organizer when multiple roles are permitted", () => {
    jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["admin", "organizer"]);
    expect(guard.canActivate(makeContext("organizer"))).toBe(true);
  });

  // ── Role denied ───────────────────────────────────────────────────────────

  it("throws ForbiddenException when user role is not in metadata roles", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
    expect(() => guard.canActivate(makeContext("user"))).toThrow(
      ForbiddenException
    );
  });

  it("throws ForbiddenException when user has no role (unauthenticated)", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(["admin"]);
    expect(() => guard.canActivate(makeContext(undefined))).toThrow(
      ForbiddenException
    );
  });

  // ── No restriction ────────────────────────────────────────────────────────

  it("allows any request when no @Roles() decorator is set (undefined)", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue(undefined);
    expect(guard.canActivate(makeContext("user"))).toBe(true);
  });

  it("allows any request when @Roles() is set to empty array", () => {
    jest.spyOn(reflector, "getAllAndOverride").mockReturnValue([]);
    expect(guard.canActivate(makeContext("user"))).toBe(true);
  });

  // ── ROLES_KEY constant ────────────────────────────────────────────────────

  it("reads metadata from correct key", () => {
    const spy = jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["admin"]);
    guard.canActivate(makeContext("admin"));
    expect(spy).toHaveBeenCalledWith(ROLES_KEY, expect.any(Array));
  });

  it("checks both handler and class level metadata", () => {
    const spy = jest
      .spyOn(reflector, "getAllAndOverride")
      .mockReturnValue(["admin"]);
    guard.canActivate(makeContext("admin"));
    // getAllAndOverride receives array of [handler, class]
    const targets = spy.mock.calls[0][1] as unknown[];
    expect(targets).toHaveLength(2);
  });
});
