import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
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

 
  const redisHost = process.env.REDIS_HOST || "redis";
  const redisPort = Number(process.env.REDIS_PORT) || 6379;
  const redisPassword = process.env.REDIS_PASSWORD;

  const pubClient = createClient({
    url: `redis://${redisPassword ? `:${redisPassword}@` : ""}${redisHost}:${redisPort}`,
  });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  console.log("✅ Redis clients connected");

  class RedisAdapter extends IoAdapter {
    create(port: number, options?: any) {
      const server = super.create(port, options);
      server.adapter(createAdapter(pubClient, subClient));
      console.log("✅ Redis adapter attached to Socket.IO server");
      return server;
    }
  }

  const configService = app.get(ConfigService);
  const rawOrigins = configService.getOrThrow<string>("CORS_ORIGINS");
  const allowedOrigins = rawOrigins.split(",").map(o => o.trim()).filter(Boolean);

  if (allowedOrigins.length === 0) {
    throw new Error("CORS_ORIGINS must contain at least one origin");
  }

  app.set("trust proxy", ["loopback", "10.0.0.0/8", "192.168.0.0/16"]);
  app.enableCors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  });


  app.use(helmet());
  app.use(cookieParser());

  app.use("/payment/webhook", bodyParser.raw({ type: "*/*" }));

  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));


  const nodeEnv = configService.getOrThrow<string>("NODE_ENV");
  const swaggerEnabled =
    configService.get<string>("SWAGGER_ENABLED") === "true" || nodeEnv !== "production";

  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Ticket_System")
      .setVersion("1.1.3")
      .addCookieAuth("access_token", { type: "apiKey", in: "cookie" }, "access_token")
      .addCookieAuth("refresh_token", { type: "apiKey", in: "cookie" }, "refresh_token")
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("swagger", app, document);
  }


  const portValue = configService.getOrThrow<string>("PORT");
  const port = Number(portValue);
  if (Number.isNaN(port) || port <= 0) {
    throw new Error("PORT must be a valid positive number");
  }

  await app.listen(port);
  console.log(`🚀 App running on port ${port}`);
}

bootstrap().catch((error: unknown) => {
  console.error("Bootstrap failed", error);
  process.exit(1);
});