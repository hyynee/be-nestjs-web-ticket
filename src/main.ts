import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as bodyParser from "body-parser";
import * as express from "express";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import helmet from 'helmet';
import { WINSTON_MODULE_NEST_PROVIDER } from "nest-winston";

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  const rawOrigins = process.env.CORS_ORIGINS || 'http://localhost:3000';
  const allowedOrigins = rawOrigins.split(',').map(o => o.trim());

  app.set('trust proxy', ['loopback', '10.0.0.0/8', '192.168.0.0/16']);
  app.enableCors({
    origin: allowedOrigins,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  });

  app.use(helmet());
  app.use(express.static("."));
  app.use(cookieParser());
  app.use("/payment/webhook", bodyParser.raw({ type: "application/json" }));
  app.useLogger(app.get(WINSTON_MODULE_NEST_PROVIDER));

  const swaggerEnabled = process.env.SWAGGER_ENABLED === 'true' 
    || process.env.NODE_ENV !== 'production';

  if (swaggerEnabled) {
    const config = new DocumentBuilder()
      .setTitle("Ticket_System")
      .setVersion("1.1.3")
      .addBearerAuth()
      .addCookieAuth("access_token", {
        type: "apiKey",
        in: "cookie",
      })
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup("swagger", app, document);
  }

  const port = process.env.PORT || 9000;
  await app.listen(port);
}
bootstrap();