import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
  ValidationPipe,
} from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";
import { MetricsInterceptor } from "./metrics/metrics.interceptor";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { MulterModule } from "@nestjs/platform-express";
import * as multer from "multer";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./config/database.module";
import { UserModule } from "./user/user.module";
import { EventModule } from "./event/event.module";
import { ZoneModule } from "./zone/zone.module";
import { AreaModule } from "./area/area.module";
import { SeatMapModule } from "./seat-map/seat-map.module";
import { BookingModule } from "./booking/booking.module";
import { PaymentModule } from "./payment/payment.module";
import { ThrottlerModule } from "@nestjs/throttler";
import { ThrottlerStorageRedisService } from "@nest-lab/throttler-storage-redis";
import { UploadController } from "./upload/uploadImage";
import { LockLoginModule } from "./lock-login/lock-login.module";
import { TicketModule } from "./ticket/ticket.module";
import { ChatModule } from "./chatbot/chat.module";
import { CustomThrottlerGuard } from "./helper/throtler.helper";
import { StatisticalModule } from "./statistical/statistical.module";
import { LoggerModule } from "./logger/logger.module";
import { CacheModule } from "@nestjs/cache-manager";
import { createKeyv } from "@keyv/redis";
import { EventsModule } from "./events/events.module";
import { ExportModule } from "./export/export.module";
import { ScheduleModule } from "@nestjs/schedule";
import { RedisModule } from "./redis/redis.module";
import { GeoIpMiddleware } from "./middleware/geoip.middleware";
import { CorrelationIdMiddleware } from "./middleware/correlation-id.middleware";
import { StripeIpMiddleware } from "./middleware/stripe-ip.middleware";
import { validateEnvironment } from "./config/env.validation";
import { QueueModule } from "@src/queue/queue.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { MetricsModule } from "./metrics/metrics.module";
import { CurrencyModule } from "./currency/currency.module";
import { AuditModule } from "./audit/audit.module";
import { HealthModule } from "./health/health.module";
import { AiccModule } from "./aicc/aicc.module";
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvironment,
    }),
    DatabaseModule,
    ScheduleModule.forRoot(),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.getOrThrow<string>("REDIS_HOST");
        const port = config.getOrThrow<string>("REDIS_PORT");
        const password = config.get<string>("REDIS_PASSWORD");
        const db = config.get<string>("REDIS_DB") ?? "0";
        const auth = password ? `:${password}@` : "";
        const redisUrl = `redis://${auth}${host}:${port}/${db}`;
        return {
          storage: new ThrottlerStorageRedisService(redisUrl),
          throttlers: [
            { name: "short", ttl: 5000, limit: 20 },
            { name: "medium", ttl: 60000, limit: 120 },
            { name: "long", ttl: 86400000, limit: 5000 },
          ],
          errorMessage: "Quá nhiều request. Vui lòng thử lại sau.",
        };
      },
    }),
    CacheModule.registerAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const host = config.getOrThrow<string>("REDIS_HOST");
        const port = config.getOrThrow<string>("REDIS_PORT");
        const password = config.get<string>("REDIS_PASSWORD");
        const db = config.get<string>("REDIS_DB") ?? "0";
        const auth = password ? `:${password}@` : "";
        const redisUrl = `redis://${auth}${host}:${port}/${db}`;
        return {
          stores: [createKeyv(redisUrl)],
          ttl: 30_000,
        };
      },
    }),
    RedisModule,
    AuthModule,
    UserModule,
    EventModule,
    ZoneModule,
    AreaModule,
    SeatMapModule,
    BookingModule,
    PaymentModule,
    // cau hinh de upload image
    MulterModule.register({
      storage: multer.memoryStorage(),
    }),
    LockLoginModule,
    TicketModule,
    ChatModule,
    StatisticalModule,
    LoggerModule,
    EventsModule,
    ExportModule,
    QueueModule,
    MetricsModule,
    CurrencyModule,
    AuditModule,
    HealthModule,
    AiccModule,
  ],
  controllers: [AppController, UploadController],
  providers: [
    AppService,
    {
      provide: APP_FILTER,
      useClass: AllExceptionsFilter,
    },
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: MetricsInterceptor,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware).forRoutes("*");

    consumer
      .apply(GeoIpMiddleware)
      .forRoutes(
        { path: "auth/login", method: RequestMethod.POST },
        { path: "ticket/checkin", method: RequestMethod.POST }
      );

    consumer
      .apply(StripeIpMiddleware)
      .forRoutes({ path: "payment/webhook", method: RequestMethod.POST });
  }
}
