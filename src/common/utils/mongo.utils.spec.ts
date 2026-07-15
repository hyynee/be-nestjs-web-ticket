import { isDuplicateKeyError } from "./mongo.utils";

describe("isDuplicateKeyError", () => {
  it("returns false for null", () => {
    expect(isDuplicateKeyError(null)).toBe(false);
  });

  it("returns false for undefined", () => {
    expect(isDuplicateKeyError(undefined)).toBe(false);
  });

  it("returns false for non-object values", () => {
    expect(isDuplicateKeyError("string")).toBe(false);
    expect(isDuplicateKeyError(42)).toBe(false);
    expect(isDuplicateKeyError(true)).toBe(false);
  });

  it("returns true when code is 11000", () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
  });

  it("returns true when code is 11001", () => {
    expect(isDuplicateKeyError({ code: 11001 })).toBe(true);
  });

  it("returns false when code is not a duplicate key code", () => {
    expect(isDuplicateKeyError({ code: 12345 })).toBe(false);
  });

  it("returns true when writeErrors contains a match with code 11000", () => {
    const error = {
      writeErrors: [{ code: 11000 }],
    };
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("returns true when writeErrors contains a match with code 11001", () => {
    const error = {
      writeErrors: [{ code: 11001 }],
    };
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("returns true when writeErrors contains a match in nested err.code", () => {
    const error = {
      writeErrors: [{ err: { code: 11000 } }],
    };
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("returns false when writeErrors has no matching entries", () => {
    const error = {
      writeErrors: [{ code: 99999 }],
    };
    expect(isDuplicateKeyError(error)).toBe(false);
  });

  it("returns false when writeErrors is an empty array", () => {
    const error = {
      writeErrors: [],
    };
    expect(isDuplicateKeyError(error)).toBe(false);
  });

  it("reads writeErrors from result.writeErrors fallback", () => {
    const error = {
      result: { writeErrors: [{ code: 11000 }] },
    };
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("returns false when writeErrors via result has no match", () => {
    const error = {
      result: { writeErrors: [{ code: 99999 }] },
    };
    expect(isDuplicateKeyError(error)).toBe(false);
  });

  it("returns false when writeErrors in result is empty", () => {
    const error = {
      result: { writeErrors: [] },
    };
    expect(isDuplicateKeyError(error)).toBe(false);
  });

  it("handles mixed writeErrors - some matching, some not", () => {
    const error = {
      writeErrors: [{ code: 99999 }, { code: 11000 }, { code: 88888 }],
    };
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("handles result with writeErrors having nested err.code", () => {
    const error = {
      result: { writeErrors: [{ err: { code: 11000 } }] },
    };
    expect(isDuplicateKeyError(error)).toBe(true);
  });

  it("returns false when all writeErrors have non-duplicate codes", () => {
    const error = {
      writeErrors: [{ code: 11111 }, { code: 22222 }],
    };
    expect(isDuplicateKeyError(error)).toBe(false);
  });
});
