export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

export const REFRESH_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days
export const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;

export const SHADOW_TTL_SECONDS = 30;

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const TWO_FACTOR_PENDING_TTL_SECONDS = 5 * 60; // 5 minutes to submit OTP after password check
export const TWO_FACTOR_RECOVERY_CODE_COUNT = 8;
