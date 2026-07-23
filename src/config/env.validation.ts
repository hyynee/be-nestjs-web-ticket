type EnvMap = Record<string, unknown>;

const ALLOWED_NODE_ENVS = new Set(["development", "test", "production"]);
const ALLOWED_SAME_SITE = new Set(["lax", "strict", "none"]);

function requireString(env: EnvMap, key: string): string {
  const value = env[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`[ENV] Missing required environment variable: ${key}`);
  }
  return value.trim();
}

function requireNumber(env: EnvMap, key: string): number {
  const value = requireString(env, key);
  const parsed = Number(value);

  if (Number.isNaN(parsed)) {
    throw new Error(`[ENV] ${key} must be a valid number`);
  }

  return parsed;
}

export function validateEnvironment(env: EnvMap): EnvMap {
  const nodeEnv = requireString(env, "NODE_ENV").toLowerCase();
  if (!ALLOWED_NODE_ENVS.has(nodeEnv)) {
    throw new Error(
      `[ENV] NODE_ENV must be one of: ${Array.from(ALLOWED_NODE_ENVS).join(", ")}`
    );
  }

  const requiredStringKeys = [
    "PORT",
    "CORS_ORIGINS",
    "MONGODB_URI",
    "SECRET_KEY",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_CALLBACK_URL",
    "FRONTEND_URL",
    "CLOUDINARY_CLOUD_NAME",
    "CLOUDINARY_API_KEY",
    "CLOUDINARY_API_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "PAYPAL_CLIENT_ID",
    "PAYPAL_CLIENT_SECRET",
    "SMTP_HOST",
    "SMTP_PORT",
    "SMTP_USER",
    "SMTP_PASS",
    "REDIS_HOST",
    "REDIS_PORT",
    "OLLAMA_URL",
    "OLLAMA_MODEL",
  ];

  for (const key of requiredStringKeys) {
    requireString(env, key);
  }

  // REDIS_PASSWORD is optional: only check if set
  if (env.REDIS_PASSWORD !== undefined && env.REDIS_PASSWORD !== "") {
    requireString(env, "REDIS_PASSWORD");
  }

  if (env.VND_TO_USD_RATE !== undefined && env.VND_TO_USD_RATE !== "") {
    const rate = Number(env.VND_TO_USD_RATE);
    if (!Number.isInteger(rate) || rate < 10_000 || rate > 100_000) {
      throw new Error(
        "[ENV] VND_TO_USD_RATE must be an integer between 10,000 and 100,000 (VND per 1 USD)"
      );
    }
  }

  requireNumber(env, "PORT");
  requireNumber(env, "SMTP_PORT");
  requireNumber(env, "REDIS_PORT");

  if (env.REDIS_DB !== undefined && env.REDIS_DB !== "") {
    requireNumber(env, "REDIS_DB");
  }

  if (env.REDIS_QUEUE_HOST !== undefined && env.REDIS_QUEUE_HOST !== "") {
    requireString(env, "REDIS_QUEUE_HOST");
  }

  if (env.REDIS_QUEUE_PORT !== undefined && env.REDIS_QUEUE_PORT !== "") {
    requireNumber(env, "REDIS_QUEUE_PORT");
  }

  if (
    env.REDIS_QUEUE_PASSWORD !== undefined &&
    env.REDIS_QUEUE_PASSWORD !== ""
  ) {
    requireString(env, "REDIS_QUEUE_PASSWORD");
  }

  if (env.REDIS_QUEUE_DB !== undefined && env.REDIS_QUEUE_DB !== "") {
    requireNumber(env, "REDIS_QUEUE_DB");
  }

  if (env.REDIS_SECURITY_HOST !== undefined && env.REDIS_SECURITY_HOST !== "") {
    requireString(env, "REDIS_SECURITY_HOST");
  }

  if (env.REDIS_SECURITY_PORT !== undefined && env.REDIS_SECURITY_PORT !== "") {
    requireNumber(env, "REDIS_SECURITY_PORT");
  }

  if (
    env.REDIS_SECURITY_PASSWORD !== undefined &&
    env.REDIS_SECURITY_PASSWORD !== ""
  ) {
    requireString(env, "REDIS_SECURITY_PASSWORD");
  }

  if (env.REDIS_SECURITY_DB !== undefined && env.REDIS_SECURITY_DB !== "") {
    requireNumber(env, "REDIS_SECURITY_DB");
  }

  if (env.REDIS_SECURITY_TLS !== undefined && env.REDIS_SECURITY_TLS !== "") {
    const tlsValue = String(env.REDIS_SECURITY_TLS).toLowerCase();
    if (tlsValue !== "true" && tlsValue !== "false") {
      throw new Error(
        "[ENV] REDIS_SECURITY_TLS must be either 'true' or 'false'"
      );
    }
  }

  // REDIS_SECURITY_* is the JWT blacklist/session-revocation store. It MUST
  // be a genuinely separate Redis endpoint in production: reusing
  // redis-cache (evictable, volatile-lru) silently reintroduces PRE-1
  // (revoked tokens can be evicted and re-validate); reusing redis-queue's
  // host+port collapses auth and BullMQ into one failure domain (a queue
  // outage would also 401 every authenticated request — see
  // production-readiness-audit-2026-07-23.md, "Redis outage blast-radius
  // merged"). Host/port is compared, not just the DB index, because two
  // connections to the same physical instance still share its memory
  // policy and availability regardless of logical DB — only host/port
  // isolation actually removes the shared instance as a SPOF.
  if (nodeEnv === "production") {
    const securityHostStr =
      env.REDIS_SECURITY_HOST !== undefined
        ? String(env.REDIS_SECURITY_HOST).trim()
        : "";
    if (!securityHostStr) {
      throw new Error(
        "[ENV] REDIS_SECURITY_HOST is required in production — without a dedicated security Redis instance, the JWT blacklist falls back to redis-cache/redis-queue, reintroducing PRE-1 or collapsing auth and BullMQ into one failure domain"
      );
    }

    const securityPort = requireNumber(env, "REDIS_SECURITY_PORT");
    const cacheHost = String(env.REDIS_HOST ?? "")
      .trim()
      .toLowerCase();
    const cachePort = requireNumber(env, "REDIS_PORT");

    if (
      securityHostStr.toLowerCase() === cacheHost &&
      securityPort === cachePort
    ) {
      throw new Error(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as REDIS_HOST/PORT (the evictable cache instance) in production"
      );
    }

    const queueHostRaw = env.REDIS_QUEUE_HOST;
    const queueHostStr =
      queueHostRaw !== undefined ? String(queueHostRaw).trim() : "";
    const effectiveQueueHost = (queueHostStr || cacheHost).toLowerCase();
    const effectiveQueuePort = queueHostStr
      ? requireNumber(env, "REDIS_QUEUE_PORT")
      : cachePort;

    if (
      securityHostStr.toLowerCase() === effectiveQueueHost &&
      securityPort === effectiveQueuePort
    ) {
      throw new Error(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as the queue Redis (REDIS_QUEUE_HOST/PORT, or REDIS_HOST/PORT if the queue has no dedicated host) in production — a shared instance collapses auth and BullMQ into a single failure domain"
      );
    }
  }

  const secretKey = requireString(env, "SECRET_KEY");
  if (secretKey === "your-secret-key") {
    throw new Error(
      "[ENV] SECRET_KEY must not use the default insecure value 'your-secret-key'"
    );
  }
  if (secretKey.length < 32) {
    throw new Error(
      "[ENV] SECRET_KEY must be at least 32 characters long for HS256 security"
    );
  }

  const rawSameSite = env.AUTH_COOKIE_SAME_SITE;
  const sameSite =
    rawSameSite === undefined || String(rawSameSite).trim() === ""
      ? "lax"
      : String(rawSameSite).toLowerCase();
  if (!ALLOWED_SAME_SITE.has(sameSite)) {
    throw new Error(
      "[ENV] AUTH_COOKIE_SAME_SITE must be one of: lax, strict, none"
    );
  }

  const rawSecure = env.AUTH_COOKIE_SECURE;
  const secureValue =
    rawSecure === undefined || String(rawSecure).trim() === ""
      ? nodeEnv === "production"
        ? "true"
        : "false"
      : String(rawSecure).toLowerCase();
  if (secureValue !== "true" && secureValue !== "false") {
    throw new Error(
      "[ENV] AUTH_COOKIE_SECURE must be either 'true' or 'false'"
    );
  }

  if (sameSite === "none" && secureValue !== "true") {
    throw new Error(
      "[ENV] AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true"
    );
  }

  // ALERT_EMAIL is required in production — missing it means refund failure alerts
  // are silently dropped and manual refunds go unnoticed.
  const alertEmail = env.ALERT_EMAIL;
  const alertEmailStr =
    alertEmail !== undefined ? String(alertEmail).trim() : "";
  if (alertEmailStr) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(alertEmailStr)) {
      throw new Error("[ENV] ALERT_EMAIL must be a valid email address");
    }
  } else if (nodeEnv === "production") {
    throw new Error(
      "[ENV] ALERT_EMAIL is required in production — set it to receive refund failure alerts (e.g. ops@yourdomain.com)"
    );
  }

  return {
    ...env,
    NODE_ENV: nodeEnv,
    AUTH_COOKIE_SECURE: secureValue,
    AUTH_COOKIE_SAME_SITE: sameSite,
    ALERT_EMAIL: alertEmailStr || undefined,
  };
}
