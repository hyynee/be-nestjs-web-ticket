describe("config", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("returns env vars via getters", () => {
    process.env.MONGODB_URI = "mongodb://test";
    process.env.SECRET_KEY = "secret123";
    process.env.NODE_ENV = "test";

    const config = require("./config").default;
    expect(config.MONGODB_URI).toBe("mongodb://test");
    expect(config.SECRET_KEY).toBe("secret123");
    expect(config.NODE_ENV).toBe("test");
  });

  it("returns undefined for unset optional vars", () => {
    delete process.env.OLLAMA_URL;
    const config = require("./config").default;
    expect(config.OLLAMA_URL).toBeUndefined();
  });

  it("returns fallback for APP_TIMEZONE when not set", () => {
    delete process.env.APP_TIMEZONE;
    const config = require("./config").default;
    expect(config.APP_TIMEZONE).toBe("+07:00");
  });

  it("returns explicit APP_TIMEZONE when set", () => {
    process.env.APP_TIMEZONE = "+08:00";
    const config = require("./config").default;
    expect(config.APP_TIMEZONE).toBe("+08:00");
  });

  it("reads SMTP config from env", () => {
    process.env.SMTP_HOST = "smtp.test.com";
    process.env.SMTP_PORT = "587";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASS = "pass";

    const config = require("./config").default;
    expect(config.SMTP_HOST).toBe("smtp.test.com");
    expect(config.SMTP_PORT).toBe("587");
    expect(config.SMTP_USER).toBe("user");
    expect(config.SMTP_PASS).toBe("pass");
  });

  describe("AUTH_COOKIE_DOMAIN", () => {
    it("returns undefined when not set", () => {
      delete process.env.AUTH_COOKIE_DOMAIN;
      const config = require("./config").default;
      expect(config.AUTH_COOKIE_DOMAIN).toBeUndefined();
    });

    it("returns the value when set", () => {
      process.env.AUTH_COOKIE_DOMAIN = ".example.com";
      const config = require("./config").default;
      expect(config.AUTH_COOKIE_DOMAIN).toBe(".example.com");
    });
  });

  describe("AUTH_COOKIE_SAME_SITE", () => {
    it("returns undefined when not set", () => {
      delete process.env.AUTH_COOKIE_SAME_SITE;
      const config = require("./config").default;
      expect(config.AUTH_COOKIE_SAME_SITE).toBeUndefined();
    });

    it("returns the value when set", () => {
      process.env.AUTH_COOKIE_SAME_SITE = "lax";
      const config = require("./config").default;
      expect(config.AUTH_COOKIE_SAME_SITE).toBe("lax");
    });
  });

  describe("AUTH_COOKIE_SECURE", () => {
    it("returns undefined when not set", () => {
      delete process.env.AUTH_COOKIE_SECURE;
      const config = require("./config").default;
      expect(config.AUTH_COOKIE_SECURE).toBeUndefined();
    });

    it("returns the value when set", () => {
      process.env.AUTH_COOKIE_SECURE = "true";
      const config = require("./config").default;
      expect(config.AUTH_COOKIE_SECURE).toBe("true");
    });
  });

  describe("all getters return correct env values", () => {
    it("returns GOOGLE_CLIENT_ID", () => {
      process.env.GOOGLE_CLIENT_ID = "google-id-123";
      const config = require("./config").default;
      expect(config.GOOGLE_CLIENT_ID).toBe("google-id-123");
    });

    it("returns GOOGLE_CLIENT_SECRET", () => {
      process.env.GOOGLE_CLIENT_SECRET = "google-secret";
      const config = require("./config").default;
      expect(config.GOOGLE_CLIENT_SECRET).toBe("google-secret");
    });

    it("returns GOOGLE_CALLBACK_URL", () => {
      process.env.GOOGLE_CALLBACK_URL = "http://localhost/auth/google/callback";
      const config = require("./config").default;
      expect(config.GOOGLE_CALLBACK_URL).toBe(
        "http://localhost/auth/google/callback"
      );
    });

    it("returns FRONTEND_URL", () => {
      process.env.FRONTEND_URL = "http://localhost:3000";
      const config = require("./config").default;
      expect(config.FRONTEND_URL).toBe("http://localhost:3000");
    });

    it("returns CLOUDINARY vars", () => {
      process.env.CLOUDINARY_CLOUD_NAME = "mycloud";
      process.env.CLOUDINARY_API_KEY = "apikey";
      process.env.CLOUDINARY_API_SECRET = "apisecret";
      const config = require("./config").default;
      expect(config.CLOUDINARY_CLOUD_NAME).toBe("mycloud");
      expect(config.CLOUDINARY_API_KEY).toBe("apikey");
      expect(config.CLOUDINARY_API_SECRET).toBe("apisecret");
    });

    it("returns STRIPE vars", () => {
      process.env.STRIPE_SECRET_KEY = "sk_test_xxx";
      process.env.STRIPE_WEBHOOK_SECRET = "whsec_xxx";
      const config = require("./config").default;
      expect(config.STRIPE_SECRET_KEY).toBe("sk_test_xxx");
      expect(config.STRIPE_WEBHOOK_SECRET).toBe("whsec_xxx");
    });

    it("returns PAYPAL vars", () => {
      process.env.PAYPAL_CLIENT_ID = "paypal-id";
      process.env.PAYPAL_CLIENT_SECRET = "paypal-secret";
      const config = require("./config").default;
      expect(config.PAYPAL_CLIENT_ID).toBe("paypal-id");
      expect(config.PAYPAL_CLIENT_SECRET).toBe("paypal-secret");
    });

    it("returns OLLAMA vars", () => {
      process.env.OLLAMA_URL = "http://ollama:11434";
      process.env.OLLAMA_MODEL = "llama3";
      const config = require("./config").default;
      expect(config.OLLAMA_URL).toBe("http://ollama:11434");
      expect(config.OLLAMA_MODEL).toBe("llama3");
    });
  });
});
