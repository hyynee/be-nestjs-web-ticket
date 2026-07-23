export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1 hour
export const ACCESS_TOKEN_TTL_MS = ACCESS_TOKEN_TTL_SECONDS * 1000;

export const REFRESH_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60; // 3 days
export const REFRESH_TOKEN_TTL_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;

// Reuse-detection window MUST cover the full refresh-token lifetime — a shorter
// window lets a stolen/replayed token evade breach detection once it expires.
export const SHADOW_TTL_SECONDS = REFRESH_TOKEN_TTL_SECONDS;

export const EMAIL_VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export const TWO_FACTOR_PENDING_TTL_SECONDS = 5 * 60; // 5 minutes to submit OTP after password check
export const TWO_FACTOR_RECOVERY_CODE_COUNT = 8;
