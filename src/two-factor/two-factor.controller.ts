import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
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
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { TwoFactorService } from "./two-factor.service";
import { VerifyTwoFactorDto } from "./dto/verify-2fa.dto";

@Controller("auth/2fa")
@ApiTags("Auth - Two-Factor")
@ApiCookieAuth("access_token")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin", "organizer")
export class TwoFactorController {
  constructor(private readonly twoFactorService: TwoFactorService) {}

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Post("setup")
  @ApiOperation({
    summary: "Bắt đầu thiết lập 2FA — trả về secret/QR/recovery codes",
  })
  @ApiResponse({
    status: 409,
    description: "2FA đã được bật, cần disable trước",
  })
  async setup(
    @CurrentUser() currentUser: JwtPayload
  ): ReturnType<TwoFactorService["setup"]> {
    return this.twoFactorService.setup(currentUser.userId);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("verify")
  @ApiOperation({ summary: "Xác nhận OTP đầu tiên để kích hoạt 2FA" })
  @ApiResponse({ status: 401, description: "OTP không đúng" })
  async verify(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: VerifyTwoFactorDto
  ): ReturnType<TwoFactorService["confirmSetup"]> {
    return this.twoFactorService.confirmSetup(currentUser.userId, dto.otp);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("disable")
  @ApiOperation({
    summary: "Tắt 2FA (yêu cầu OTP hoặc recovery code hiện tại)",
  })
  @ApiResponse({ status: 401, description: "OTP/recovery code không đúng" })
  async disable(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: VerifyTwoFactorDto
  ): ReturnType<TwoFactorService["disable"]> {
    return this.twoFactorService.disable(currentUser.userId, dto.otp);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @Post("recovery-codes/regenerate")
  @ApiOperation({ summary: "Tạo lại toàn bộ recovery code (huỷ code cũ)" })
  @ApiResponse({ status: 401, description: "OTP/recovery code không đúng" })
  async regenerateRecoveryCodes(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: VerifyTwoFactorDto
  ): ReturnType<TwoFactorService["regenerateRecoveryCodes"]> {
    return this.twoFactorService.regenerateRecoveryCodes(
      currentUser.userId,
      dto.otp
    );
  }
}
