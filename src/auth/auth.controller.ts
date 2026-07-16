import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { AuthService, SessionRequestMeta } from "./auth.service";
import { LoginDTO } from "./dto/login.dto";
import { RegisterDTO } from "./dto/create.dto";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "./decorator/currentUser.decorator";
import {
  ApiCookieAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { ChangePasswordDTO } from "./dto/password.dto";
import { JwtPayload } from "./dto/jwt-payload.dto";
import { LockLoginGuard } from "@src/guards/lock-login.guard";
import { ForgotPassword } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { VerifyEmailDto } from "./dto/verify-email.dto";
import { ResendVerificationEmailDto } from "./dto/resend-verification-email.dto";
import { LoginTwoFactorDto } from "@src/two-factor/dto/login-2fa.dto";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";

@Controller("auth")
@ApiTags("Auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  private extractSessionMeta(req: Request): SessionRequestMeta {
    const meta: SessionRequestMeta = {
      ipAddress: req.ip || undefined,
      userAgent: req.headers["user-agent"],
    };
    return meta;
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @Post("register")
  @ApiOperation({ summary: "Đăng ký người dùng mới" })
  @ApiResponse({ status: 201, description: "Đăng ký thành công" })
  @ApiResponse({ status: 409, description: "Email đã tồn tại" })
  register(@Body() data: RegisterDTO): ReturnType<AuthService["register"]> {
    return this.authService.register(data);
  }

  @Throttle({ short: { limit: 5, ttl: 5000 } })
  @Post("login")
  @HttpCode(200)
  @UseGuards(LockLoginGuard)
  @ApiOperation({ summary: "Đăng nhập bằng email và mật khẩu" })
  @ApiResponse({ status: 200, description: "Đăng nhập thành công" })
  @ApiResponse({ status: 401, description: "Thông tin đăng nhập không hợp lệ" })
  async login(
    @Body() loginDto: LoginDTO,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthService["login"]> {
    return this.authService.login(loginDto, this.extractSessionMeta(req), res);
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
  async completeTwoFactorLogin(
    @Body() dto: LoginTwoFactorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthService["completeTwoFactorLogin"]> {
    return this.authService.completeTwoFactorLogin(
      dto.twoFactorToken,
      dto.otp,
      this.extractSessionMeta(req),
      res
    );
  }

  @Get("google")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Bắt đầu đăng nhập bằng Google" })
  @ApiResponse({
    status: 302,
    description: "Chuyển hướng đến trang đăng nhập Google",
  })
  async googleLogin(): Promise<void> {
    // Endpoint này khởi tạo luồng OAuth Google và chuyển hướng đến trang đăng nhập Google
  }

  @Get("google/callback")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Xử lý callback đăng nhập Google" })
  @ApiResponse({
    status: 302,
    description: "Set cookie HttpOnly và chuyển hướng về frontend",
  })
  @ApiResponse({ status: 400, description: "Profile Google không hợp lệ" })
  async googleLoginCallback(
    @Req() req: Request,
    @Res() res: Response
  ): ReturnType<AuthService["handleGoogleLoginCallback"]> {
    return this.authService.handleGoogleLoginCallback(
      req.user,
      this.extractSessionMeta(req),
      res
    );
  }

  @Get("status")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Kiểm tra trạng thái đăng nhập" })
  @ApiResponse({ status: 200, description: "Trạng thái đăng nhập" })
  status(): ReturnType<AuthService["status"]> {
    return this.authService.status();
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @Post("refresh-token")
  @ApiCookieAuth("refresh_token")
  @ApiOperation({ summary: "Làm mới JWT token" })
  refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthService["refreshToken"]> {
    const refreshToken =
      typeof req.cookies?.refresh_token === "string"
        ? req.cookies.refresh_token
        : "";
    return this.authService.refreshToken(
      refreshToken,
      this.extractSessionMeta(req),
      res
    );
  }

  @Get("me")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Lấy thông tin người dùng hiện tại" })
  getCurrentUser(
    @CurrentUser() currentUser: JwtPayload
  ): ReturnType<AuthService["getUserById"]> {
    const userId = currentUser.userId;
    return this.authService.getUserById(userId);
  }

  @Post("logout")
  @HttpCode(204)
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Đăng xuất người dùng" })
  logout(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ): ReturnType<AuthService["logout"]> {
    const refreshToken =
      typeof req.cookies?.refresh_token === "string"
        ? req.cookies.refresh_token
        : undefined;

    return this.authService.logout(refreshToken, res, req);
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
  ): ReturnType<AuthService["logoutAll"]> {
    return this.authService.logoutAll(currentUser.userId, res, req);
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
  ): ReturnType<AuthService["getSessions"]> {
    const currentRawToken =
      typeof req.cookies?.refresh_token === "string"
        ? req.cookies.refresh_token
        : undefined;
    return this.authService.getSessions(currentUser.userId, currentRawToken);
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
  ): ReturnType<AuthService["revokeSession"]> {
    return this.authService.revokeSession(currentUser.userId, sessionId);
  }

  @Put("change-password")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Thay đổi mật khẩu người dùng" })
  changePassword(
    @CurrentUser() currentUser: JwtPayload,
    @Body() data: ChangePasswordDTO
  ): ReturnType<AuthService["changePassword"]> {
    const userId = currentUser.userId;
    return this.authService.changePassword(userId, data);
  }

  @Throttle({ short: { limit: 2, ttl: 60000 } })
  @HttpCode(200)
  @Post("/forgotPassword")
  async forgotPassword(
    @Body() forgotPassword: ForgotPassword
  ): ReturnType<AuthService["forgotPassword"]> {
    return this.authService.forgotPassword(forgotPassword.email);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("/resetPassword")
  async resetPassword(
    @Body() data: ResetPasswordDto
  ): ReturnType<AuthService["resetPassword"]> {
    return this.authService.resetPassword(data);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("verify-email")
  @ApiOperation({ summary: "Xác thực địa chỉ email bằng token" })
  @ApiResponse({ status: 200, description: "Xác thực email thành công" })
  @ApiResponse({ status: 400, description: "Token không hợp lệ hoặc hết hạn" })
  async verifyEmail(
    @Body() data: VerifyEmailDto
  ): ReturnType<AuthService["verifyEmail"]> {
    return this.authService.verifyEmail(data);
  }

  @Throttle({ short: { limit: 2, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("resend-verification")
  @ApiOperation({ summary: "Gửi lại email xác thực" })
  @ApiResponse({ status: 200, description: "Đã gửi (nếu email hợp lệ)" })
  async resendVerification(
    @Body() data: ResendVerificationEmailDto
  ): ReturnType<AuthService["resendVerificationEmail"]> {
    return this.authService.resendVerificationEmail(data.email);
  }
}
