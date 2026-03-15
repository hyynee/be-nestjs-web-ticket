import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
  HttpCode,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { LoginDTO } from "./dto/login.dto";
import { RegisterDTO } from "./dto/create.dto";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "./decorator/currentUser.decorator";
import {
  ApiBearerAuth,
  ApiTags,
  ApiOperation,
  ApiResponse,
} from "@nestjs/swagger";
import { ChangePasswordDTO } from "./dto/password.dto";
import { JwtPayload } from "./dto/jwt-payload.dto";
import { LockLoginGuard } from "@src/guards/lock-login.guard";
import { ForgotPassword } from "./dto/forgot-password.dto";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";

@Controller("auth")
@ApiTags("Auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}


  @Throttle({ medium: { limit: 10, ttl: 60000 } })
  @Post("register")
  @ApiOperation({ summary: "Đăng ký người dùng mới" })
  @ApiResponse({ status: 201, description: "Đăng ký thành công" })
  @ApiResponse({ status: 409, description: "Email đã tồn tại" })
  register(@Body() data: RegisterDTO) {
    return this.authService.register(data);
  }

  @Throttle({ short: { limit: 5, ttl: 5000 } })
  @Post("login")
  @UseGuards(LockLoginGuard)
  @ApiOperation({ summary: "Đăng nhập bằng email và mật khẩu" })
  @ApiResponse({ status: 200, description: "Đăng nhập thành công" })
  @ApiResponse({ status: 401, description: "Thông tin đăng nhập không hợp lệ" })
  async login(
    @Body() loginDto: LoginDTO,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    return this.authService.login(loginDto, req.ip || "unknown", res);
  }
  @Get("google")
  @UseGuards(AuthGuard("google"))
  @ApiOperation({ summary: "Bắt đầu đăng nhập bằng Google" })
  @ApiResponse({
    status: 302,
    description: "Chuyển hướng đến trang đăng nhập Google",
  })
  async googleLogin() {
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
  async googleLoginCallback(@Req() req: Request, @Res() res: Response) {
    return this.authService.handleGoogleLoginCallback(req.user, res);
  }

  @Get("status")
  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Kiểm tra trạng thái đăng nhập" })
  @ApiResponse({ status: 200, description: "Trạng thái đăng nhập" })
  async status() {
    return this.authService.status();
  }

  @Post("refresh-token")
  @ApiOperation({ summary: "Làm mới JWT token" })
  refreshToken(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const refreshToken = req.cookies?.refresh_token;
    return this.authService.refreshToken(refreshToken, res);
  }

  @Get("me")
  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Lấy thông tin người dùng hiện tại" })
  getCurrentUser(@CurrentUser() currentUser: JwtPayload) {
    const userId = currentUser.userId;
    return this.authService.getUserById(userId);
  }

  @Post("logout")
  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Đăng xuất người dùng" })
  logout(
    @CurrentUser() currentUser: JwtPayload,
    @Res({ passthrough: true }) res: Response
  ) {
    const userId = currentUser.userId;
    return this.authService.logout(userId, res);
  }

  @Put("change-password")
  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Thay đổi mật khẩu người dùng" })
  changePassword(
    @CurrentUser() currentUser: JwtPayload,
    @Body() data: ChangePasswordDTO
  ) {
    const userId = currentUser.userId;
    return this.authService.changePassword(userId, data);
  }


  @HttpCode(200)
  @Post('/forgotPassword')
  async forgotPassword(
    @Body() forgotPassword: ForgotPassword
  ) {
    return this.authService.forgotPassword(forgotPassword.email);
  }

  @HttpCode(200)
  @Put('/resetPassword')
  async resetPassword(
    @Body() data: ResetPasswordDto
  ) {
    return this.authService.resetPassword(data);
  }
}
