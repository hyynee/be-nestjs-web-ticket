import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import { LoggerService } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import * as bodyParser from "body-parser";
import helmet from "helmet";
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });

  const logger = app.get<LoggerService>(WINSTON_MODULE_NEST_PROVIDER);

  const redisHost = process.env.REDIS_HOST || "redis";
  const redisPort = Number(process.env.REDIS_PORT) || 6379;
  const redisPassword = process.env.REDIS_PASSWORD;
  const redisDb = Number(process.env.REDIS_DB || 0);

  const pubClient = createClient({
    socket: {
      host: redisHost,
      port: redisPort,
      reconnectStrategy: (retries: number) => {
        if (retries > 20)
          return new Error("Redis pub/sub: max reconnect attempts exceeded");
        return Math.min(retries * 200, 3000);
      },
    },
    ...(redisPassword ? { password: redisPassword } : {}),
    database: redisDb,
  });
  const subClient = pubClient.duplicate();

  pubClient.on("error", (err: Error) =>
    logger.error(
      `Redis pubClient error: ${err.message}`,
      undefined,
      "Bootstrap"
    )
  );
  subClient.on("error", (err: Error) =>
    logger.error(
      `Redis subClient error: ${err.message}`,
      undefined,
      "Bootstrap"
    )
  );

  await Promise.all([pubClient.connect(), subClient.connect()]);
  logger.log("Redis clients connected", "Bootstrap");

  class RedisAdapter extends IoAdapter {
    createIOServer(port: number, options?: any): any {
      const server = super.createIOServer(port, options);
      server.adapter(createAdapter(pubClient, subClient));
      logger.log("Redis adapter attached to Socket.IO server", "Bootstrap");
      return server;
    }
  }

  const configService = app.get(ConfigService);
  const rawOrigins = configService.getOrThrow<string>("CORS_ORIGINS");
  const allowedOrigins = rawOrigins
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (allowedOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must contain at least one origin");
  }

  app.setGlobalPrefix("api/v1", {
    exclude: [
      "auth/google/callback",
      "auth/google",
      "health",
      "ready",
      "health/live",
      "health/ready",
      "metrics",
      "internal/metrics",
    ],
  });
  app.set("trust proxy", ["loopback", "10.0.0.0/8", "192.168.0.0/16"]);
  app.enableCors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  });

  app.use(helmet());
  app.use(cookieParser());

  app.use("/payment/webhook", bodyParser.raw({ type: "application/json" }));

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  const isProduction = configService.get<string>("NODE_ENV") === "production";
  const swaggerEnabled =
    !isProduction && configService.get<string>("SWAGGER_ENABLED") === "true";

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Ticket_System")
      .setVersion("1.1.3")
      .addCookieAuth(
        "access_token",
        { type: "apiKey", in: "cookie" },
        "access_token"
      )
      .addCookieAuth(
        "refresh_token",
        { type: "apiKey", in: "cookie" },
        "refresh_token"
      )
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("swagger", app, document);
  }

  const portValue = configService.getOrThrow<string>("PORT");
  const port = Number(portValue);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error("PORT must be a valid positive number");
  }

  app.useWebSocketAdapter(new RedisAdapter(app));

  app.enableShutdownHooks();

  await app.listen(port);
  logger.log(`App running on port ${port}`, "Bootstrap");

  const shutdown = async (signal: string) => {
    logger.log(
      `Received ${signal}, starting graceful shutdown...`,
      "Bootstrap"
    );
    const timeoutHandle = setTimeout(() => {
      logger.error(
        "Graceful shutdown timed out after 30s — forcing exit",
        undefined,
        "Bootstrap"
      );
      process.exit(1);
    }, 30_000);
    timeoutHandle.unref();
    try {
      await app.close();
      await Promise.all([
        pubClient.isOpen
          ? pubClient.quit().catch(() => undefined)
          : Promise.resolve(),
        subClient.isOpen
          ? subClient.quit().catch(() => undefined)
          : Promise.resolve(),
      ]);
      clearTimeout(timeoutHandle);
      logger.log("Graceful shutdown complete", "Bootstrap");
      process.exit(0);
    } catch (err) {
      logger.error(
        `Shutdown error: ${(err as Error).message}`,
        undefined,
        "Bootstrap"
      );
      process.exit(1);
    }
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

bootstrap().catch((error: unknown) => {
  console.error("Bootstrap failed", error);
  process.exit(1);
});
