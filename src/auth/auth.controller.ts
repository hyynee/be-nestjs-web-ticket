import {
  Body,
  Controller,
  Get,
  Post,
  Put,
  Request,
  Response,
  UseGuards,
} from "@nestjs/common";
import { AuthService } from "./auth.service";
import { LoginDTO } from "./dto/login.dto";
import { RegisterDTO } from "./dto/create.dto";
import { RefreshTokenDTO } from "./dto/refreshToken.dto";
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

@Controller("auth")
@ApiTags("Auth")
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("register")
  @ApiOperation({ summary: "Đăng ký người dùng mới" })
  @ApiResponse({ status: 201, description: "Đăng ký thành công" })
  @ApiResponse({ status: 409, description: "Email đã tồn tại" })
  register(@Body() data: RegisterDTO) {
    return this.authService.register(data);
  }

  @Post("login")
  @UseGuards(LockLoginGuard)
  @ApiOperation({ summary: "Đăng nhập bằng email và mật khẩu" })
  @ApiResponse({ status: 200, description: "Đăng nhập thành công" })
  @ApiResponse({ status: 401, description: "Thông tin đăng nhập không hợp lệ" })
  login(@Body() loginDto: LoginDTO,@Request() req) {
    return this.authService.login(loginDto,req.ip);
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
    description: "Chuyển hướng về frontend với token",
  })
  @ApiResponse({ status: 400, description: "Profile Google không hợp lệ" })
  async googleLoginCallback(@Request() req, @Response() res) {
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
  refreshToken(@Body() token: RefreshTokenDTO) {
    return this.authService.refreshToken(token);
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
  logout(@CurrentUser() currentUser: JwtPayload) {
    const userId = currentUser.userId;
    const accessToken = currentUser.accessToken;
    return this.authService.logout(userId, accessToken);
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
}
