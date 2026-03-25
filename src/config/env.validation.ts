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
    "REDIS_PASSWORD",
    "OLLAMA_URL",
    "OLLAMA_MODEL",
  ];

  for (const key of requiredStringKeys) {
    requireString(env, key);
  }

  requireNumber(env, "PORT");
  requireNumber(env, "SMTP_PORT");
  requireNumber(env, "REDIS_PORT");

  if (env.REDIS_DB !== undefined && env.REDIS_DB !== "") {
    requireNumber(env, "REDIS_DB");
  }

  const secretKey = requireString(env, "SECRET_KEY");
  if (secretKey === "your-secret-key") {
    throw new Error(
      "[ENV] SECRET_KEY must not use the default insecure value 'your-secret-key'"
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

  return {
    ...env,
    NODE_ENV: nodeEnv,
    AUTH_COOKIE_SECURE: secureValue,
    AUTH_COOKIE_SAME_SITE: sameSite,
  };
}
