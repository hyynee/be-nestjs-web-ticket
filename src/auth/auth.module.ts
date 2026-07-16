import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { UserSchema } from "@src/schemas/user.schema";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "@src/strategy/jwt.strategy";
import { GoogleStrategy } from "@src/strategy/google.strategy";
import { LockLoginModule } from "@src/lock-login/lock-login.module";
import { MailModule } from "@src/services/mail.module";
import { ResetTokenSchema } from "@src/schemas/reset-token.schema";
import { EmailVerificationTokenSchema } from "@src/schemas/email-verification-token.schema";
import { SessionSchema } from "@src/schemas/session.schema";
import { EventsModule } from "@src/events/events.module";
import { TwoFactorModule } from "@src/two-factor/two-factor.module";
import { ConfigService } from "@nestjs/config";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "User", schema: UserSchema },
      { name: "ResetToken", schema: ResetTokenSchema },
      {
        name: "EmailVerificationToken",
        schema: EmailVerificationTokenSchema,
      },
      { name: "Session", schema: SessionSchema },
    ]),

    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        global: true,
        secret: configService.getOrThrow<string>("SECRET_KEY"),
        signOptions: { expiresIn: "1h", algorithm: "HS256" },
        verifyOptions: { algorithms: ["HS256"] },
      }),
    }),

    PassportModule,
    LockLoginModule,
    EventsModule,
    MailModule,
    TwoFactorModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, GoogleStrategy],
})
export class AuthModule {}
