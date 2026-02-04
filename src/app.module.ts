import { Module, ValidationPipe } from "@nestjs/common";
import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ConfigModule } from "@nestjs/config";
import { MulterModule } from '@nestjs/platform-express';
import * as multer from 'multer';
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./config/database.module";
import { JwtStrategy } from "./strategy/jwt.strategy";
import { UserModule } from "./user/user.module";
import { GoogleStrategy } from "./strategy/google.strategy";
import { EventModule } from "./event/event.module";
import { ZoneModule } from "./zone/zone.module";
import { AreaModule } from "./area/area.module";
import { BookingModule } from './booking/booking.module';
import { PaymentModule } from './payment/payment.module';
import { ThrottlerModule } from "@nestjs/throttler";
import { UploadController } from "./upload/uploadImage";
import { LockLoginModule } from './lock-login/lock-login.module';
import { TicketModule } from './ticket/ticket.module';
import { ChatModule } from "./chatbot/chat.module";
import { APP_GUARD } from "@nestjs/core";
import { APP_PIPE } from '@nestjs/core';
import { CustomThrottlerGuard } from "./helper/throtler.helper";
import { StatisticalModule } from './statistical/statistical.module';
import { LoggerModule } from "./logger/logger.module";
import { CacheModule } from "@nestjs/cache-manager";
import { EventsModule } from "./events/events.module";
import { ExportModule } from "./export/export.module";
@Module({
  imports: [
    DatabaseModule,
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot({
      throttlers: [
        {
          name: 'short',
          ttl: 5000,
          limit: 20,
        },
        {
          name: 'medium',
          ttl: 60000,
          limit: 120,
        },
        {
          name: 'long',
          ttl: 86400000,
          limit: 5000,
        },
      ],
      errorMessage: "Quá nhiều request. Vui lòng thử lại sau.",
    }),
    CacheModule.register({
      isGlobal: true,
      ttl: 30000,
      max: 100,
    }),
    AuthModule,
    UserModule,
    EventModule,
    ZoneModule,
    AreaModule,
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
    ExportModule
  ],
  controllers: [AppController, UploadController],
  providers: [
    AppService,
    JwtStrategy,
    GoogleStrategy,
    {
      provide: APP_GUARD,
      useClass: CustomThrottlerGuard,
    },
    {
      provide: APP_PIPE,
      useClass: ValidationPipe,
      useValue: new ValidationPipe({
        transform: true,
        whitelist: true,
      }),
    }
  ],
})
export class AppModule { }
