import { validateEnvironment } from "./env.validation";

describe("validateEnvironment", () => {
  const validEnv: Record<string, unknown> = {
    NODE_ENV: "test",
    PORT: "3000",
    CORS_ORIGINS: "http://localhost:3000",
    MONGODB_URI: "mongodb://localhost/test",
    SECRET_KEY: "my-secret-key-change-me-at-least-32ch",
    GOOGLE_CLIENT_ID: "google-id",
    GOOGLE_CLIENT_SECRET: "google-secret",
    GOOGLE_CALLBACK_URL: "http://localhost/auth/google/callback",
    FRONTEND_URL: "http://localhost:3000",
    CLOUDINARY_CLOUD_NAME: "cloud",
    CLOUDINARY_API_KEY: "key",
    CLOUDINARY_API_SECRET: "secret",
    STRIPE_SECRET_KEY: "sk_test_xxx",
    STRIPE_WEBHOOK_SECRET: "whsec_xxx",
    PAYPAL_CLIENT_ID: "paypal-id",
    PAYPAL_CLIENT_SECRET: "paypal-secret",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_USER: "user",
    SMTP_PASS: "pass",
    REDIS_HOST: "localhost",
    REDIS_PORT: "6379",
    OLLAMA_URL: "http://localhost:11434",
    OLLAMA_MODEL: "llama3",
  };

  // Production requires ALERT_EMAIL and a dedicated REDIS_SECURITY_HOST/PORT
  // (distinct from REDIS_HOST/PORT and REDIS_QUEUE_HOST/PORT) — this fixture
  // is the minimal valid production env, used by every production-path test
  // that isn't itself testing one of these two requirements.
  const validProdEnv: Record<string, unknown> = {
    ...validEnv,
    NODE_ENV: "production",
    ALERT_EMAIL: "ops@example.com",
    REDIS_SECURITY_HOST: "redis-security",
    REDIS_SECURITY_PORT: "6390",
  };

  it("returns enriched env object for valid input", () => {
    const result = validateEnvironment({ ...validEnv });
    expect(result.NODE_ENV).toBe("test");
    expect(result.AUTH_COOKIE_SAME_SITE).toBe("lax");
    expect(result.AUTH_COOKIE_SECURE).toBe("false");
  });

  describe("NODE_ENV", () => {
    it("throws when NODE_ENV is missing", () => {
      const env = { ...validEnv };
      delete env.NODE_ENV;
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] Missing required environment variable: NODE_ENV"
      );
    });

    it("throws when NODE_ENV is invalid", () => {
      const env = { ...validEnv, NODE_ENV: "staging" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] NODE_ENV must be one of: development, test, production"
      );
    });

    it("accepts production", () => {
      const env = { ...validProdEnv };
      const result = validateEnvironment(env);
      expect(result.NODE_ENV).toBe("production");
      expect(result.AUTH_COOKIE_SECURE).toBe("true");
    });

    it("accepts development", () => {
      const env = { ...validEnv, NODE_ENV: "development" };
      const result = validateEnvironment(env);
      expect(result.NODE_ENV).toBe("development");
    });

    it("lowercases NODE_ENV", () => {
      const env = {
        ...validProdEnv,
        NODE_ENV: "PRODUCTION",
      };
      const result = validateEnvironment(env);
      expect(result.NODE_ENV).toBe("production");
    });
  });

  describe("missing required keys", () => {
    const requiredKeys = [
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

    for (const key of requiredKeys) {
      it(`throws when ${key} is missing`, () => {
        const env = { ...validEnv };
        delete env[key];
        expect(() => validateEnvironment(env)).toThrow(
          `[ENV] Missing required environment variable: ${key}`
        );
      });
    }

    it("throws when a required key is empty string", () => {
      const env = { ...validEnv, PORT: "" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] Missing required environment variable: PORT"
      );
    });

    it("throws when a required key is not a string", () => {
      const env = { ...validEnv, PORT: 12345 };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] Missing required environment variable: PORT"
      );
    });
  });

  describe("PORT validation", () => {
    it("throws when PORT is non-numeric", () => {
      const env = { ...validEnv, PORT: "not-a-number" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] PORT must be a valid number"
      );
    });

    it("throws when SMTP_PORT is non-numeric", () => {
      const env = { ...validEnv, SMTP_PORT: "abc" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] SMTP_PORT must be a valid number"
      );
    });

    it("throws when REDIS_PORT is non-numeric", () => {
      const env = { ...validEnv, REDIS_PORT: "abc" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_PORT must be a valid number"
      );
    });
  });

  describe("SECRET_KEY", () => {
    it("throws when SECRET_KEY is the default insecure value", () => {
      const env = { ...validEnv, SECRET_KEY: "your-secret-key" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] SECRET_KEY must not use the default insecure value 'your-secret-key'"
      );
    });

    it("throws when SECRET_KEY is shorter than 32 characters", () => {
      const env = { ...validEnv, SECRET_KEY: "too-short-key" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] SECRET_KEY must be at least 32 characters long for HS256 security"
      );
    });

    it("accepts a SECRET_KEY that is exactly 32 characters", () => {
      const env = { ...validEnv, SECRET_KEY: "a".repeat(32) };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("accepts a SECRET_KEY longer than 32 characters", () => {
      const env = { ...validEnv, SECRET_KEY: "a".repeat(64) };
      expect(() => validateEnvironment(env)).not.toThrow();
    });
  });

  describe("AUTH_COOKIE_SAME_SITE", () => {
    it("defaults to lax when not set", () => {
      const env = { ...validEnv };
      delete env.AUTH_COOKIE_SAME_SITE;
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SAME_SITE).toBe("lax");
    });

    it("defaults to lax when empty string", () => {
      const env = { ...validEnv, AUTH_COOKIE_SAME_SITE: "" };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SAME_SITE).toBe("lax");
    });

    it("accepts strict", () => {
      const env = { ...validEnv, AUTH_COOKIE_SAME_SITE: "strict" };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SAME_SITE).toBe("strict");
    });

    it("accepts none", () => {
      const env = {
        ...validEnv,
        AUTH_COOKIE_SAME_SITE: "none",
        AUTH_COOKIE_SECURE: "true",
      };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SAME_SITE).toBe("none");
    });

    it("throws when invalid value provided", () => {
      const env = { ...validEnv, AUTH_COOKIE_SAME_SITE: "invalid" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] AUTH_COOKIE_SAME_SITE must be one of: lax, strict, none"
      );
    });

    it("lowercases the value", () => {
      const env = {
        ...validEnv,
        AUTH_COOKIE_SAME_SITE: "NONE",
        AUTH_COOKIE_SECURE: "true",
      };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SAME_SITE).toBe("none");
    });
  });

  describe("AUTH_COOKIE_SECURE", () => {
    it("defaults to true in production", () => {
      const env = { ...validProdEnv };
      delete env.AUTH_COOKIE_SECURE;
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SECURE).toBe("true");
    });

    it("defaults to false in non-production", () => {
      const env = { ...validEnv, NODE_ENV: "development" };
      delete env.AUTH_COOKIE_SECURE;
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SECURE).toBe("false");
    });

    it("accepts explicit true", () => {
      const env = { ...validEnv, AUTH_COOKIE_SECURE: "true" };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SECURE).toBe("true");
    });

    it("accepts explicit false", () => {
      const env = { ...validEnv, AUTH_COOKIE_SECURE: "false" };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SECURE).toBe("false");
    });

    it("throws on invalid value", () => {
      const env = { ...validEnv, AUTH_COOKIE_SECURE: "maybe" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] AUTH_COOKIE_SECURE must be either 'true' or 'false'"
      );
    });

    it("lowercases AUTH_COOKIE_SECURE", () => {
      const env = { ...validEnv, AUTH_COOKIE_SECURE: "TRUE" };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SECURE).toBe("true");
    });
  });

  describe("sameSite=none requires secure=true", () => {
    it("throws when sameSite=none and secure is false", () => {
      const env = {
        ...validEnv,
        AUTH_COOKIE_SAME_SITE: "none",
        AUTH_COOKIE_SECURE: "false",
      };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true"
      );
    });

    it("throws when sameSite=none and secure is default false (non-prod)", () => {
      const env = {
        ...validEnv,
        NODE_ENV: "development",
        AUTH_COOKIE_SAME_SITE: "none",
      };
      delete env.AUTH_COOKIE_SECURE;
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] AUTH_COOKIE_SAME_SITE=none requires AUTH_COOKIE_SECURE=true"
      );
    });

    it("passes when sameSite=none and secure=true", () => {
      const env = {
        ...validEnv,
        AUTH_COOKIE_SAME_SITE: "none",
        AUTH_COOKIE_SECURE: "true",
      };
      const result = validateEnvironment(env);
      expect(result.AUTH_COOKIE_SAME_SITE).toBe("none");
      expect(result.AUTH_COOKIE_SECURE).toBe("true");
    });
  });

  describe("REDIS_PASSWORD (optional)", () => {
    it("passes when not set", () => {
      const env = { ...validEnv };
      delete env.REDIS_PASSWORD;
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes when empty string", () => {
      const env = { ...validEnv, REDIS_PASSWORD: "" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with a valid password", () => {
      const env = { ...validEnv, REDIS_PASSWORD: "myredispass" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });
  });

  describe("VND_TO_USD_RATE (optional)", () => {
    it("passes when not set", () => {
      const env = { ...validEnv };
      delete env.VND_TO_USD_RATE;
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes when empty string", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with valid integer in range", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "23000" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes at lower bound (10000)", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "10000" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes at upper bound (100000)", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "100000" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("throws when below lower bound", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "9999" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] VND_TO_USD_RATE must be an integer between 10,000 and 100,000 (VND per 1 USD)"
      );
    });

    it("throws when above upper bound", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "100001" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] VND_TO_USD_RATE must be an integer between 10,000 and 100,000 (VND per 1 USD)"
      );
    });

    it("throws when not an integer", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "23000.5" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] VND_TO_USD_RATE must be an integer between 10,000 and 100,000 (VND per 1 USD)"
      );
    });

    it("throws when non-numeric string", () => {
      const env = { ...validEnv, VND_TO_USD_RATE: "abc" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] VND_TO_USD_RATE must be an integer between 10,000 and 100,000 (VND per 1 USD)"
      );
    });
  });

  describe("REDIS_DB (optional)", () => {
    it("passes when not set", () => {
      const env = { ...validEnv };
      delete env.REDIS_DB;
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes when empty string", () => {
      const env = { ...validEnv, REDIS_DB: "" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with valid number", () => {
      const env = { ...validEnv, REDIS_DB: "0" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("throws when non-numeric", () => {
      const env = { ...validEnv, REDIS_DB: "abc" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_DB must be a valid number"
      );
    });
  });

  describe("REDIS_SECURITY_DB (optional)", () => {
    it("passes when not set", () => {
      const env = { ...validEnv };
      delete env.REDIS_SECURITY_DB;
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes when empty string", () => {
      const env = { ...validEnv, REDIS_SECURITY_DB: "" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with valid number", () => {
      const env = { ...validEnv, REDIS_SECURITY_DB: "1" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("throws when non-numeric", () => {
      const env = { ...validEnv, REDIS_SECURITY_DB: "abc" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_DB must be a valid number"
      );
    });
  });

  describe("REDIS_SECURITY_TLS (optional)", () => {
    it("passes when not set", () => {
      const env = { ...validEnv };
      delete env.REDIS_SECURITY_TLS;
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes when empty string", () => {
      const env = { ...validEnv, REDIS_SECURITY_TLS: "" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with 'true'", () => {
      const env = { ...validEnv, REDIS_SECURITY_TLS: "true" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with 'false'", () => {
      const env = { ...validEnv, REDIS_SECURITY_TLS: "false" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("throws when neither 'true' nor 'false'", () => {
      const env = { ...validEnv, REDIS_SECURITY_TLS: "yes" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_TLS must be either 'true' or 'false'"
      );
    });
  });

  describe("ALERT_EMAIL (optional in non-prod, required in production)", () => {
    it("passes when not set in non-production", () => {
      const env = { ...validEnv };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with a valid email", () => {
      const env = { ...validEnv, ALERT_EMAIL: "ops@example.com" };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("throws when set to an invalid email format", () => {
      const env = { ...validEnv, ALERT_EMAIL: "not-an-email" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] ALERT_EMAIL must be a valid email address"
      );
    });

    it("throws in production when ALERT_EMAIL is missing", () => {
      const env = { ...validProdEnv };
      delete env.ALERT_EMAIL;
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] ALERT_EMAIL is required in production"
      );
    });

    it("throws in production when ALERT_EMAIL is empty string", () => {
      const env = { ...validProdEnv, ALERT_EMAIL: "" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] ALERT_EMAIL is required in production"
      );
    });

    it("passes in production with a valid ALERT_EMAIL", () => {
      const env = { ...validProdEnv };
      const result = validateEnvironment(env);
      expect(result.ALERT_EMAIL).toBe("ops@example.com");
    });
  });

  describe("REDIS_SECURITY_HOST/PORT (required and isolated in production)", () => {
    it("passes when not set in non-production", () => {
      const env = { ...validEnv };
      delete env.REDIS_SECURITY_HOST;
      delete env.REDIS_SECURITY_PORT;
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("passes with a valid, distinct REDIS_SECURITY_HOST/PORT in production", () => {
      const env = { ...validProdEnv };
      expect(() => validateEnvironment(env)).not.toThrow();
    });

    it("throws in production when REDIS_SECURITY_HOST is missing", () => {
      const env = { ...validProdEnv };
      delete env.REDIS_SECURITY_HOST;
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST is required in production"
      );
    });

    it("throws in production when REDIS_SECURITY_HOST is an empty string", () => {
      const env = { ...validProdEnv, REDIS_SECURITY_HOST: "" };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST is required in production"
      );
    });

    it("throws in production when REDIS_SECURITY_PORT is missing", () => {
      const env = { ...validProdEnv };
      delete env.REDIS_SECURITY_PORT;
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] Missing required environment variable: REDIS_SECURITY_PORT"
      );
    });

    it("throws in production when REDIS_SECURITY_HOST/PORT is the same endpoint as REDIS_HOST/PORT (cache)", () => {
      const env = {
        ...validProdEnv,
        REDIS_SECURITY_HOST: validProdEnv.REDIS_HOST,
        REDIS_SECURITY_PORT: validProdEnv.REDIS_PORT,
      };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as REDIS_HOST/PORT"
      );
    });

    it("throws in production when REDIS_SECURITY_HOST/PORT is the same endpoint as REDIS_QUEUE_HOST/PORT", () => {
      const env = {
        ...validProdEnv,
        REDIS_QUEUE_HOST: "redis-queue",
        REDIS_QUEUE_PORT: "6380",
        REDIS_SECURITY_HOST: "redis-queue",
        REDIS_SECURITY_PORT: "6380",
      };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as the queue Redis"
      );
    });

    it("throws in production even when REDIS_SECURITY_DB differs from the queue's DB — host/port equality alone is disqualifying", () => {
      const env = {
        ...validProdEnv,
        REDIS_QUEUE_HOST: "redis-queue",
        REDIS_QUEUE_PORT: "6380",
        REDIS_QUEUE_DB: "0",
        REDIS_SECURITY_HOST: "redis-queue",
        REDIS_SECURITY_PORT: "6380",
        REDIS_SECURITY_DB: "5",
      };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as the queue Redis"
      );
    });

    it("throws in production when REDIS_SECURITY_HOST matches REDIS_HOST but REDIS_QUEUE_HOST is unset (queue would itself fall back to cache)", () => {
      const env = {
        ...validProdEnv,
        REDIS_SECURITY_HOST: validProdEnv.REDIS_HOST,
        REDIS_SECURITY_PORT: validProdEnv.REDIS_PORT,
      };
      delete env.REDIS_QUEUE_HOST;
      delete env.REDIS_QUEUE_PORT;
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as REDIS_HOST/PORT"
      );
    });

    it("is case-insensitive when comparing hosts", () => {
      const env = {
        ...validProdEnv,
        REDIS_SECURITY_HOST: String(validProdEnv.REDIS_HOST).toUpperCase(),
        REDIS_SECURITY_PORT: validProdEnv.REDIS_PORT,
      };
      expect(() => validateEnvironment(env)).toThrow(
        "[ENV] REDIS_SECURITY_HOST/PORT must not be the same endpoint as REDIS_HOST/PORT"
      );
    });
  });
});
