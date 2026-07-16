import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import {
  ApiCookieAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "../decorator/currentUser.decorator";
import { JwtPayload } from "../dto/jwt-payload.dto";
import { LoginDTO } from "../dto/login.dto";
import { LockLoginGuard } from "@src/guards/lock-login.guard";
import { LoginTwoFactorDto } from "@src/two-factor/dto/login-2fa.dto";
import type { Request, Response } from "express";
import { AuthLoginService } from "../application/auth-login.service";
import { AuthSessionService } from "../application/auth-session.service";
import { AuthUserQueryService } from "../application/auth-user-query.service";
import { extractSessionMeta } from "./auth-request-meta.util";

@Controller("auth")
@ApiTags("Auth")
export class AuthSessionController {
  constructor(
    private readonly authLoginService: AuthLoginService,
    private readonly authSessionService: AuthSessionService,
    private readonly authUserQueryService: AuthUserQueryService
  ) {}

  @Throttle({ short: { limit: 5, ttl: 5000 } })
  @Post("login")
  @HttpCode(200)
  @UseGuards(LockLoginGuard)
  @ApiOperation({ summary: "Đăng nhập bằng email và mật khẩu" })
  @ApiResponse({ status: 200, description: "Đăng nhập thành công" })
  @ApiResponse({ status: 401, description: "Thông tin đăng nhập không hợp lệ" })
  login(
    @Body() loginDto: LoginDTO,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthLoginService["login"]> {
    return this.authLoginService.login(loginDto, extractSessionMeta(req), res);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Post("2fa/login")
  @HttpCode(200)
  @ApiOperation({
    summary:
      "Hoàn tất đăng nhập bằng OTP/recovery code (sau khi login trả requires2fa)",
  })
  @ApiResponse({ status: 200, description: "Đăng nhập thành công" })
  @ApiResponse({
    status: 401,
    description: "OTP/recovery code không đúng hoặc phiên đã hết hạn",
  })
  completeTwoFactorLogin(
    @Body() dto: LoginTwoFactorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthLoginService["completeTwoFactorLogin"]> {
    return this.authLoginService.completeTwoFactorLogin(
      dto.twoFactorToken,
      dto.otp,
      extractSessionMeta(req),
      res
    );
  }

  @Get("status")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Kiểm tra trạng thái đăng nhập" })
  @ApiResponse({ status: 200, description: "Trạng thái đăng nhập" })
  status(): ReturnType<AuthUserQueryService["status"]> {
    return this.authUserQueryService.status();
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @Post("refresh-token")
  @ApiCookieAuth("refresh_token")
  @ApiOperation({ summary: "Làm mới JWT token" })
  refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthSessionService["refreshToken"]> {
    const refreshToken =
      typeof req.cookies?.refresh_token === "string"
        ? req.cookies.refresh_token
        : "";
    return this.authSessionService.refreshToken(
      refreshToken,
      extractSessionMeta(req),
      res
    );
  }

  @Post("logout")
  @HttpCode(204)
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Đăng xuất người dùng" })
  logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthSessionService["logout"]> {
    const refreshToken =
      typeof req.cookies?.refresh_token === "string"
        ? req.cookies.refresh_token
        : undefined;

    return this.authSessionService.logout(refreshToken, res, req);
  }

  @Post("logout-all")
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Đăng xuất khỏi tất cả thiết bị" })
  logoutAll(
    @CurrentUser() currentUser: JwtPayload,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthSessionService["logoutAll"]> {
    return this.authSessionService.logoutAll(currentUser.userId, res, req);
  }

  @Get("sessions")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({
    summary: "Danh sách thiết bị/phiên đăng nhập đang hoạt động",
  })
  getSessions(
    @CurrentUser() currentUser: JwtPayload,
    @Req() req: Request
  ): ReturnType<AuthSessionService["getSessions"]> {
    const currentRawToken =
      typeof req.cookies?.refresh_token === "string"
        ? req.cookies.refresh_token
        : undefined;
    return this.authSessionService.getSessions(
      currentUser.userId,
      currentRawToken
    );
  }

  @Delete("sessions/:id")
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Thu hồi một phiên đăng nhập cụ thể" })
  @ApiResponse({
    status: 404,
    description: "Session không tồn tại hoặc đã bị thu hồi",
  })
  revokeSession(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") sessionId: string
  ): ReturnType<AuthSessionService["revokeSession"]> {
    return this.authSessionService.revokeSession(currentUser.userId, sessionId);
  }
}
