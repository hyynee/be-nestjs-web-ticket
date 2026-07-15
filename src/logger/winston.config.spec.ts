describe("winstonConfig", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("has levels with error=0 and debug=5", () => {
    const { winstonConfig } = require("./winston.config");
    expect(winstonConfig.levels.error).toBe(0);
    expect(winstonConfig.levels.debug).toBe(5);
  });

  it("has a Console transport", () => {
    const { winstonConfig } = require("./winston.config");
    expect(winstonConfig.transports).toHaveLength(1);
    expect(winstonConfig.transports[0].constructor.name).toBe("Console");
  });

  it("uses debug level in non-production env", () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "development";
    const { winstonConfig: cfg } = require("./winston.config");
    expect(cfg.transports[0].level).toBe("debug");
  });

  it("uses info level in production env", () => {
    delete process.env.LOG_LEVEL;
    process.env.NODE_ENV = "production";
    const { winstonConfig: cfg } = require("./winston.config");
    expect(cfg.transports[0].level).toBe("info");
  });

  it("respects LOG_LEVEL env var", () => {
    process.env.LOG_LEVEL = "warn";
    const { winstonConfig: cfg } = require("./winston.config");
    expect(cfg.transports[0].level).toBe("warn");
  });
});
