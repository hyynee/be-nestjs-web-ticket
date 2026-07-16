import { Logger } from "@nestjs/common";

Logger.overrideLogger(false);

const shouldSuppressNestLog = (firstArg: unknown): boolean => {
  if (typeof firstArg === "string") {
    return firstArg.includes("[Nest]");
  }

  if (firstArg instanceof Uint8Array) {
    return Buffer.from(firstArg).toString("utf8").includes("[Nest]");
  }

  return false;
};

const originalConsole = {
  debug: console.debug,
  error: console.error,
  log: console.log,
  warn: console.warn,
};

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

const installNestLogFilter = () => {
  jest.spyOn(process.stdout, "write").mockImplementation(((chunk, ...args) => {
    if (shouldSuppressNestLog(chunk)) {
      return true;
    }

    return originalStdoutWrite(chunk, ...args);
  }) as typeof process.stdout.write);

  jest.spyOn(process.stderr, "write").mockImplementation(((chunk, ...args) => {
    if (shouldSuppressNestLog(chunk)) {
      return true;
    }

    return originalStderrWrite(chunk, ...args);
  }) as typeof process.stderr.write);

  jest.spyOn(console, "debug").mockImplementation((firstArg, ...args) => {
    if (!shouldSuppressNestLog(firstArg)) {
      originalConsole.debug(firstArg, ...args);
    }
  });

  jest.spyOn(console, "error").mockImplementation((firstArg, ...args) => {
    if (!shouldSuppressNestLog(firstArg)) {
      originalConsole.error(firstArg, ...args);
    }
  });

  jest.spyOn(console, "log").mockImplementation((firstArg, ...args) => {
    if (!shouldSuppressNestLog(firstArg)) {
      originalConsole.log(firstArg, ...args);
    }
  });

  jest.spyOn(console, "warn").mockImplementation((firstArg, ...args) => {
    if (!shouldSuppressNestLog(firstArg)) {
      originalConsole.warn(firstArg, ...args);
    }
  });
};

installNestLogFilter();

beforeEach(() => {
  installNestLogFilter();
});
