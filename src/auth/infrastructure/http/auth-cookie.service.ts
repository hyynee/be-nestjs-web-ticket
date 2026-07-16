import { Injectable } from "@nestjs/common";
import envConfig from "@src/config/config";
import { CookieOptions, Response } from "express";
import {
  ACCESS_TOKEN_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
} from "../../auth.constants";
import { AuthTokenPair } from "../../domain/types/auth.types";

@Injectable()
export class AuthCookieService {
  private isCookieSecure(): boolean {
    const rawValue = envConfig.AUTH_COOKIE_SECURE;
    if (!rawValue) {
      return envConfig.NODE_ENV === "production";
    }

    return String(rawValue).toLowerCase() === "true";
  }

  private getCookieSameSite(): "lax" | "strict" | "none" {
    const rawValue = String(
      envConfig.AUTH_COOKIE_SAME_SITE || "lax"
    ).toLowerCase();
    if (rawValue === "lax" || rawValue === "strict" || rawValue === "none") {
      return rawValue;
    }
    return "lax";
  }

  private getTokenCookieOptions(maxAge: number): CookieOptions {
    const secure = this.isCookieSecure();
    const sameSite =
      this.getCookieSameSite() === "none" && !secure
        ? "lax"
        : this.getCookieSameSite();

    const cookieOptions: CookieOptions = {
      httpOnly: true,
      secure,
      sameSite,
      maxAge,
      path: "/",
    };

    if (envConfig.AUTH_COOKIE_DOMAIN) {
      cookieOptions.domain = envConfig.AUTH_COOKIE_DOMAIN;
    }

    return cookieOptions;
  }

  setTokenCookies(res: Response, tokens: AuthTokenPair): void {
    res.cookie(
      "access_token",
      tokens.accessToken,
      this.getTokenCookieOptions(ACCESS_TOKEN_TTL_MS)
    );
    res.cookie(
      "refresh_token",
      tokens.refreshToken,
      this.getTokenCookieOptions(REFRESH_TOKEN_TTL_MS)
    );
  }

  clearTokenCookies(res: Response): void {
    const clearOptions = this.getTokenCookieOptions(0);
    res.clearCookie("access_token", clearOptions);
    res.clearCookie("refresh_token", clearOptions);
  }
}
