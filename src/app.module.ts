import { Module } from "@nestjs/common";
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

import { UploadController } from "./upload/uploadImage";
import { LockLoginModule } from './lock-login/lock-login.module';
import { TicketModule } from './ticket/ticket.module';
import { ChatModule } from "./chatbot/chat.module";

@Module({
  imports: [
    DatabaseModule,
    ConfigModule.forRoot({ isGlobal: true }),
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
  ],
  controllers: [AppController, UploadController],
  providers: [AppService, JwtStrategy, GoogleStrategy],
})
export class AppModule { }
