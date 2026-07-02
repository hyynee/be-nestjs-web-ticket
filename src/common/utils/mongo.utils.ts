export function isDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as Record<string, unknown>;
  if (e["code"] === 11000 || e["code"] === 11001) return true;

  const writeErrors =
    (e["writeErrors"] as Array<Record<string, unknown>> | undefined) ??
    ((e["result"] as Record<string, unknown> | undefined)?.["writeErrors"] as
      Array<Record<string, unknown>> | undefined);

  if (Array.isArray(writeErrors) && writeErrors.length > 0) {
    return writeErrors.some(
      (we) =>
        we["code"] === 11000 ||
        we["code"] === 11001 ||
        (we["err"] as Record<string, unknown> | undefined)?.["code"] === 11000
    );
  }
  return false;
}
