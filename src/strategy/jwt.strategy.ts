import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import { PassportStrategy } from "@nestjs/passport";
import { User } from "@src/schemas/user.schema";
import { ExtractJwt, Strategy } from "passport-jwt";
import { Request } from "express";
import { Model } from "mongoose";

type JwtClaims = {
  userId: string;
  role: string;
};

const extractAccessTokenFromCookie = (request: Request): string | null => {
  const cookies = request.cookies as
    | Record<string, string | undefined>
    | undefined;
  return cookies?.access_token ?? null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly config: ConfigService,
    @InjectModel(User.name) private readonly userModel: Model<User>
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([extractAccessTokenFromCookie]),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>("SECRET_KEY"),
    });
  }

  async validate(payload: JwtClaims) {
    if (!payload?.userId) {
      throw new UnauthorizedException("Invalid token payload");
    }

    const user = await this.userModel
      .findById(payload.userId)
      .select("_id role isActive")
      .lean();

    if (!user || user.isActive === false) {
      throw new UnauthorizedException("User not found or inactive");
    }

    return payload;
  }
}
