import { Controller, Get, Req, Res, UseGuards } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AuthLoginService } from "../application/auth-login.service";
import { extractSessionMeta } from "./auth-request-meta.util";

@Controller("auth")
@ApiTags("Auth")
export class AuthOAuthController {
  constructor(private readonly authLoginService: AuthLoginService) {}

  @Get("google")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Bắt đầu đăng nhập bằng Google" })
  @ApiResponse({
    status: 302,
    description: "Chuyển hướng đến trang đăng nhập Google",
  })
  googleLogin(): void {}

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Xử lý callback đăng nhập Google" })
  @ApiResponse({
    status: 302,
    description: "Set cookie HttpOnly và chuyển hướng về frontend",
  })
  @ApiResponse({ status: 400, description: "Profile Google không hợp lệ" })
  googleLoginCallback(
    @Req() req: Request,
    @Res() res: Response
  ): ReturnType<AuthLoginService["handleGoogleLoginCallback"]> {
    return this.authLoginService.handleGoogleLoginCallback(
      req.user,
      extractSessionMeta(req),
      res
    );
  }
}
