import winston, { format, transports } from "winston";

const customLevels = {
  levels: {
    error: 0,
    warn: 1,
    info: 2,
    http: 3,
    verbose: 4,
    debug: 5,
    silly: 6,
  },
  colors: {
    error: "red",
    warn: "yellow",
    info: "green",
    http: "magenta",
    debug: "blue",
  },
};
winston.addColors(customLevels.colors);

const defaultLevel = process.env.NODE_ENV === "production" ? "info" : "debug";
const logLevel = process.env.LOG_LEVEL ?? defaultLevel;

export const winstonConfig = {
  levels: customLevels.levels,
  transports: [
    new transports.Console({
      level: logLevel,
      format:
        process.env.NODE_ENV === "production"
          ? format.combine(
              format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
              format.json()
            )
          : format.combine(
              format.colorize(),
              format.timestamp({ format: "HH:mm:ss" }),
              format.simple()
            ),
    }),
  ],
};
