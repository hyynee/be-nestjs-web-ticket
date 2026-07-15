const MAX_USER_AGENT_LENGTH = 300;

const OS_PATTERNS: Array<[RegExp, string]> = [
  [/windows nt 10/i, "Windows 10/11"],
  [/windows nt/i, "Windows"],
  [/mac os x/i, "macOS"],
  [/android/i, "Android"],
  [/iphone/i, "iOS (iPhone)"],
  [/ipad/i, "iOS (iPad)"],
  [/linux/i, "Linux"],
];

// Order matters: Edge/Chrome UAs also contain "Safari/", so the more specific token must win.
const BROWSER_PATTERNS: Array<[RegExp, string]> = [
  [/edg\//i, "Edge"],
  [/chrome\//i, "Chrome"],
  [/firefox\//i, "Firefox"],
  [/safari\//i, "Safari"],
];

/** Truncates a raw User-Agent header to a safe storage length. */
export function sanitizeUserAgent(userAgent?: string): string | undefined {
  if (!userAgent) return undefined;
  return userAgent.slice(0, MAX_USER_AGENT_LENGTH);
}

/** Derives a human-readable device label ("Chrome on Windows 10/11") from a raw User-Agent header, without a parsing dependency. */
export function parseDeviceInfo(userAgent?: string): string | undefined {
  if (!userAgent) return undefined;

  const os = OS_PATTERNS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const browser = BROWSER_PATTERNS.find(([pattern]) =>
    pattern.test(userAgent)
  )?.[1];

  if (!os && !browser) return undefined;
  return `${browser ?? "Unknown browser"} on ${os ?? "Unknown OS"}`;
}
