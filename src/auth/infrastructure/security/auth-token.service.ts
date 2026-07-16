import { Injectable } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { v4 as uuidv4 } from "uuid";
import { ACCESS_TOKEN_TTL_SECONDS } from "../../auth.constants";
import { ActiveAuthUser } from "../../domain/types/auth.types";

@Injectable()
export class AuthTokenService {
  constructor(private readonly jwtService: JwtService) {}

  hashToken(rawToken: string): string {
    return crypto.createHash("sha256").update(rawToken).digest("hex");
  }

  issueAccessToken(user: ActiveAuthUser): string {
    return this.jwtService.sign(
      { userId: user._id.toString(), role: user.role, jti: uuidv4() },
      { expiresIn: ACCESS_TOKEN_TTL_SECONDS }
    );
  }

  verifyAccessToken(token: string): unknown {
    return this.jwtService.verify(token);
  }
}
