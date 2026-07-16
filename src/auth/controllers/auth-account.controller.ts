import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Put,
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
import { AuthAccountService } from "../application/auth-account.service";
import { AuthPasswordService } from "../application/auth-password.service";
import { AuthUserQueryService } from "../application/auth-user-query.service";
import { CurrentUser } from "../decorator/currentUser.decorator";
import { ChangePasswordDTO } from "../dto/password.dto";
import { ForgotPassword } from "../dto/forgot-password.dto";
import { JwtPayload } from "../dto/jwt-payload.dto";
import { RegisterDTO } from "../dto/create.dto";
import { ResendVerificationEmailDto } from "../dto/resend-verification-email.dto";
import { ResetPasswordDto } from "../dto/reset-password.dto";
import { VerifyEmailDto } from "../dto/verify-email.dto";

@Controller("auth")
@ApiTags("Auth")
export class AuthAccountController {
  constructor(
    private readonly authAccountService: AuthAccountService,
    private readonly authPasswordService: AuthPasswordService,
    private readonly authUserQueryService: AuthUserQueryService
  ) {}

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @Post("register")
  @ApiOperation({ summary: "Đăng ký người dùng mới" })
  @ApiResponse({ status: 201, description: "Đăng ký thành công" })
  @ApiResponse({ status: 409, description: "Email đã tồn tại" })
  register(
    @Body() data: RegisterDTO
  ): ReturnType<AuthAccountService["register"]> {
    return this.authAccountService.register(data);
  }

  @Get("me")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Lấy thông tin người dùng hiện tại" })
  getCurrentUser(
    @CurrentUser() currentUser: JwtPayload
  ): ReturnType<AuthUserQueryService["getUserById"]> {
    return this.authUserQueryService.getUserById(currentUser.userId);
  }

  @Put("change-password")
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @ApiOperation({ summary: "Thay đổi mật khẩu người dùng" })
  changePassword(
    @CurrentUser() currentUser: JwtPayload,
    @Body() data: ChangePasswordDTO
  ): ReturnType<AuthPasswordService["changePassword"]> {
    return this.authPasswordService.changePassword(currentUser.userId, data);
  }

  @Throttle({ short: { limit: 2, ttl: 60000 } })
  @HttpCode(200)
  @Post("/forgotPassword")
  forgotPassword(
    @Body() forgotPassword: ForgotPassword
  ): ReturnType<AuthPasswordService["forgotPassword"]> {
    return this.authPasswordService.forgotPassword(forgotPassword.email);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("/resetPassword")
  resetPassword(
    @Body() data: ResetPasswordDto
  ): ReturnType<AuthPasswordService["resetPassword"]> {
    return this.authPasswordService.resetPassword(data);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("verify-email")
  @ApiOperation({ summary: "Xác thực địa chỉ email bằng token" })
  @ApiResponse({ status: 200, description: "Xác thực email thành công" })
  @ApiResponse({ status: 400, description: "Token không hợp lệ hoặc hết hạn" })
  verifyEmail(
    @Body() data: VerifyEmailDto
  ): ReturnType<AuthAccountService["verifyEmail"]> {
    return this.authAccountService.verifyEmail(data);
  }

  @Throttle({ short: { limit: 2, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("resend-verification")
  @ApiOperation({ summary: "Gửi lại email xác thực" })
  @ApiResponse({ status: 200, description: "Đã gửi (nếu email hợp lệ)" })
  resendVerification(
    @Body() data: ResendVerificationEmailDto
  ): ReturnType<AuthAccountService["resendVerificationEmail"]> {
    return this.authAccountService.resendVerificationEmail(data.email);
  }
}
