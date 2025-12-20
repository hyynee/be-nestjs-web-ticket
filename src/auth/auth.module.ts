import { Module } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { MongooseModule } from "@nestjs/mongoose";
import { UserSchema } from "@src/schemas/user.schema";
import { JwtModule } from "@nestjs/jwt";
import { jwtConstants } from "./constants";
import { RefreshTokenSchema } from "@src/schemas/refresh-token.schema";
import { ResponseModule } from "@src/common/reponse/response.module";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "@src/strategy/jwt.strategy";
import { GoogleStrategy } from "@src/strategy/google.strategy";
import { LockLoginModule } from "@src/lock-login/lock-login.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: "User", schema: UserSchema },
      { name: "RefreshToken", schema: RefreshTokenSchema },
    ]),
    LockLoginModule,
    JwtModule.register({
      global: true,
      secret: jwtConstants.secret,
    }),
    PassportModule,
    ResponseModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, GoogleStrategy],
})
export class AuthModule { }
