export const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 32 random bytes hex-encoded — format of the raw email verification token sent to users. */
export const HEX_TOKEN_64_REGEX = /^[0-9a-f]{64}$/i;

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
