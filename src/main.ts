import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as bodyParser from "body-parser";
import * as express from "express";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import helmet from 'helmet';
async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', ['loopback', '10.0.0.0/8', '192.168.0.0/16']);
  app.enableCors({
    origin: ["http://localhost:5173", "http://localhost:9000", "http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  }); // cors
  app.use(helmet());
  app.use(express.static("."));
  app.use(cookieParser());
  // Middleware để xử lý raw body cho Stripe Webhook
  app.use("/payment/webhook", bodyParser.raw({ type: "application/json" }));
  const config = new DocumentBuilder()
    .setTitle("Ticket_System")
    .setVersion("1.1.3")
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup("swagger", app, document);
  await app.listen(9000);
}
bootstrap();

// nest g resource auth --no-spec
