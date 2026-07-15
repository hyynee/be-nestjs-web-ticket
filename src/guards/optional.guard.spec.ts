import { OptionalJwtAuthGuard } from "./optional.guard";

describe("OptionalJwtAuthGuard", () => {
  let guard: OptionalJwtAuthGuard;

  beforeEach(() => {
    guard = new OptionalJwtAuthGuard();
  });

  it("returns the user when authentication succeeds", () => {
    const user = { userId: "123", role: "user" };
    const result = guard.handleRequest(null, user, null, null);
    expect(result).toEqual(user);
  });

  it("returns null (not throws) when there is no user (unauthenticated request)", () => {
    const result = guard.handleRequest(null, null, null, null);
    expect(result).toBeNull();
  });

  it("returns null (not throws) when there is an authentication error", () => {
    const err = new Error("JWT expired");
    const result = guard.handleRequest(err, null, null, null);
    expect(result).toBeNull();
  });

  it("returns null (not throws) when user is undefined", () => {
    const result = guard.handleRequest(null, undefined, null, null);
    expect(result).toBeNull();
  });
});
