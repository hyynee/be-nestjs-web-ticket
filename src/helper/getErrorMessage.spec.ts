import { getErrorMessage } from "./getErrorMessage";

describe("getErrorMessage", () => {
  it("returns message for Error instances", () => {
    expect(getErrorMessage(new Error("foo"))).toBe("foo");
  });

  it("returns the string itself when err is a string", () => {
    expect(getErrorMessage("something went wrong")).toBe(
      "something went wrong"
    );
  });

  it('falls back to "Unknown error" for non-Error, non-string values', () => {
    expect(getErrorMessage(null)).toBe("Unknown error");
    expect(getErrorMessage(undefined)).toBe("Unknown error");
    expect(getErrorMessage(42)).toBe("Unknown error");
    expect(getErrorMessage({})).toBe("Unknown error");
    expect(getErrorMessage(true)).toBe("Unknown error");
  });
});
