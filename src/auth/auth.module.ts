import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
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
import { AuthAccountService } from "./application/auth-account.service";
import { AuthLoginService } from "./application/auth-login.service";
import { AuthPasswordService } from "./application/auth-password.service";
import { AuthSessionService } from "./application/auth-session.service";
import { AuthUserQueryService } from "./application/auth-user-query.service";
import { AuthUserCacheService } from "./infrastructure/cache/auth-user-cache.service";
import { AuthCookieService } from "./infrastructure/http/auth-cookie.service";
import { AuthTokenService } from "./infrastructure/security/auth-token.service";
import { AuthPresenter } from "./presenters/auth.presenter";
import { AuthAccountController } from "./controllers/auth-account.controller";
import { AuthOAuthController } from "./controllers/auth-oauth.controller";
import { AuthSessionController } from "./controllers/auth-session.controller";

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
  controllers: [
    AuthAccountController,
    AuthOAuthController,
    AuthSessionController,
  ],
  providers: [
    AuthService,
    AuthAccountService,
    AuthLoginService,
    AuthPasswordService,
    AuthSessionService,
    AuthUserQueryService,
    AuthUserCacheService,
    AuthCookieService,
    AuthTokenService,
    AuthPresenter,
    JwtStrategy,
    GoogleStrategy,
  ],
})
export class AuthModule {}
