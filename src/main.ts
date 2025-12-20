import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import * as bodyParser from "body-parser";
import * as express from "express";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: ["http://localhost:5173", "http://localhost:9000","http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE","PATCH"],
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  }); // cors
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
