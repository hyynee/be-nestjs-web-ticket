const SENSITIVE_KEYS = new Set([
  "password",
  "resettoken",
  "reset_token",
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "token",
  "secret",
  "otp",
  "pin",
]);

export const REDACTED_VALUE = "***REDACTED***";

const MAX_SANITIZE_DEPTH = 3;

/** Recursively redacts known-sensitive key names before data is surfaced to an admin API/log. */
export function sanitizeSensitiveFields(value: unknown, depth = 0): unknown {
  if (
    depth > MAX_SANITIZE_DEPTH ||
    value === null ||
    typeof value !== "object"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSensitiveFields(item, depth + 1));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      result[key] = REDACTED_VALUE;
      continue;
    }
    result[key] = sanitizeSensitiveFields(source[key], depth + 1);
  }
  return result;
}
