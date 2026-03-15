import {
  ConflictException,
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Request,
  NotFoundException,
  Inject,
} from "@nestjs/common";
import { LoginDTO } from "./dto/login.dto";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { Model } from "mongoose";
import { RegisterDTO } from "./dto/create.dto";
import { JwtService } from "@nestjs/jwt";
import { v4 as uuidv4 } from "uuid";
import { RefreshTokenDTO } from "./dto/refreshToken.dto";
import { ChangePasswordDTO } from "./dto/password.dto";
import envConfig from "@src/config/config";
import { LockLoginService } from "@src/lock-login/lock-login.service";
import { MailService } from "@src/services/mail.service";
import { ResetPasswordDto } from "./dto/reset-password.dto";
import { ResetToken } from "@src/schemas/reset-token.schema";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { UserEventsService } from "@src/events/user-event.services";
import { v2 as cloudinary } from 'cloudinary';
import { RedisService } from "@src/redis/redis.service";

const { FRONTEND_URL } = envConfig;

@Injectable()
export class AuthService {
  private readonly REFRESH_TOKEN_TTL_SECONDS = 3 * 24 * 60 * 60;

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(ResetToken.name) private readonly resetTokenModel: Model<ResetToken>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,

    private jwtService: JwtService,
    private loginAttemptService: LockLoginService,
    private readonly userEventsService: UserEventsService,
    private mailService: MailService,
    private readonly redisService: RedisService,
  ) { }
  private generateCacheKeyForUser(userId: string): string {
    return `user:details:${userId}`;
  };
  private async invalidateUserCache(userId: string): Promise<void> {
    const cacheKey = this.generateCacheKeyForUser(userId);
    await this.cacheManager.del(cacheKey);
  };

  private getRefreshTokenKey(token: string): string {
    return `auth:refresh:${token}`;
  }

  private getUserRefreshTokenSetKey(userId: string): string {
    return `auth:user:${userId}:refresh-tokens`;
  }

  private async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    const userTokenSetKey = this.getUserRefreshTokenSetKey(userId);
    const tokens = await this.redisService.client.sMembers(userTokenSetKey);

    const multi = this.redisService.client.multi();
    for (const token of tokens) {
      multi.del(this.getRefreshTokenKey(token));
    }
    multi.del(userTokenSetKey);

    await multi.exec();
  }

  async register(data: RegisterDTO): Promise<User> {
    const { email, password, confirmPassword, fullName, role = "user" } = data;
    const existingUser = await this.userModel.findOne({ email });
    if (existingUser) {
      throw new ConflictException("Email already exists");
    }
    if (password !== confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }
    const user = new this.userModel({
      email,
      password,
      fullName,
      role: role || "user",
    });
    // emit event user registered
    await user.save();
    this.userEventsService.emitUserRegistered(user);
    return user;
  }

  async login(data: LoginDTO, ip: string) {
    const { email, password } = data;
    const user = await this.userModel.findOne({ email });

    if (!user) {
      await this.loginAttemptService.recordFailedAttempt(email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    const isMatch = await user.comparePassword(password);

    if (!isMatch) {
      await this.loginAttemptService.recordFailedAttempt(email, ip);
      throw new UnauthorizedException('Invalid credentials');
    }

    // Login đúng → reset count
    await this.loginAttemptService.resetLocked(email, ip);
    // Tạo token
    return this.generateUserTokens(user._id);
  }


  async loginWithGoogle(profile: any) {
    const { email, name, picture } = profile;
    if (!email) {
      throw new BadRequestException(
        "Invalid Google profile: email is required"
      );
    }
    let user = await this.userModel.findOne({ email });
    if (!user) {
      user = new this.userModel({
        email,
        name,
        avatar: picture,
        role: "user",
      });
      await user.save();
    }
    return this.generateUserTokens(user._id);
  }

  async handleGoogleLoginCallback(profile: any, res: any) {
    const jwt = await this.loginWithGoogle(profile);
    // Redirect về trang login với tokens trong query params
    // Frontend sẽ check query params và lấy tokens để lưu vào localStorage
    const tokens = encodeURIComponent(JSON.stringify({
      accessToken: jwt.accessToken,
      refreshToken: jwt.refreshToken
    }));
    res.redirect(`${FRONTEND_URL}/login?google=true&tokens=${tokens}`);
  }

  async status() {
    return { message: "Logged in successfully" };
  }

  async getCurrentUser(@Request() req) {
    return req.currentUser;
  }

  async getUserById(id: string) {
    const cacheKey = this.generateCacheKeyForUser(id);
    let user: User | null = await this.cacheManager.get<User>(cacheKey) ?? null;
    if (!user) {
      user = await this.userModel
        .findById(id)
        .select('-password')
        .lean<User>();
      if (!user) return null;
      await this.cacheManager.set(cacheKey, user, 1800000);
    }
    const avatarUrl = user.avatarPublicId
      ? cloudinary.url(user.avatarPublicId, {
        type: 'private',
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        secure: true,
      })
      : null;
    const {avatarPublicId,...profile} = user;
    return {
      ...profile,
      avatarUrl,
    };
  }


  async refreshToken(data: RefreshTokenDTO) {
    const { refreshToken } = data;
    if (!refreshToken) {
      throw new BadRequestException("Refresh token is required");
    }

    const refreshTokenKey = this.getRefreshTokenKey(refreshToken);
    const userId = await this.redisService.client.get(refreshTokenKey);

    if (!userId) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    // Rotate refresh token: consume token cũ trước khi phát token mới.
    await this.redisService.client
      .multi()
      .del(refreshTokenKey)
      .sRem(this.getUserRefreshTokenSetKey(userId), refreshToken)
      .exec();

    return this.generateUserTokens(userId);
  }

  async logout(userId: string, accessToken: string) {
    await this.revokeAllUserRefreshTokens(userId);
    await this.invalidateUserCache(userId);
    return { message: "Logged out successfully" };
  }

  // create token
  async generateUserTokens(userId) {
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    const userIdString = user._id.toString();
    const accessToken = this.jwtService.sign(
      { userId: userIdString, role: user.role },
      { expiresIn: "1h" }
    );
    const refreshToken = uuidv4();

    // Mỗi user chỉ giữ một phiên refresh token để revoke nhanh và rõ ràng.
    await this.revokeAllUserRefreshTokens(userIdString);

    // Tạo refresh token mới
    await this.storeRefreshToken(refreshToken, userIdString);
    return { accessToken, refreshToken };
  }

  //  refresh token
  async storeRefreshToken(token: string, userId: string) {
    const refreshTokenKey = this.getRefreshTokenKey(token);
    const userTokenSetKey = this.getUserRefreshTokenSetKey(userId);

    await this.redisService.client
      .multi()
      .set(refreshTokenKey, userId, { EX: this.REFRESH_TOKEN_TTL_SECONDS })
      .sAdd(userTokenSetKey, token)
      .expire(userTokenSetKey, this.REFRESH_TOKEN_TTL_SECONDS)
      .exec();
  }

  // changePassword
  async changePassword(userId: string, data: ChangePasswordDTO) {
    const { oldPassword, newPassword } = data;
    const user = await this.userModel.findById(userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    const isMatch = await user.comparePassword(oldPassword);
    if (!isMatch) {
      throw new UnauthorizedException("Invalid old password");
    }
    user.password = newPassword;
    await user.save();
    await this.invalidateUserCache(userId);
    return { message: "Password changed successfully" };
  }

  // forgotPassword
  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.userModel.findOne({ email });
    if (!user) {
      return {
        message: "If that email address is in our system, we have sent a password reset link to it."
      };
    }
    await this.resetTokenModel.deleteMany({  // xoá các token cũ
      userId: user._id,
      isUsed: false
    });
    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + 3600000);
    await this.resetTokenModel.create({
      userId: user._id,
      token: resetToken,
      expiresAt,
      isUsed: false,
    });
    const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;
    await this.mailService.sendPasswordResetEmail(user.email, resetLink);
    return {
      message: "Password reset link has been sent to your email."
    };
  }

  async resetPassword(data: ResetPasswordDto) {
    const { resetToken, newPassword } = data;
    const token = await this.resetTokenModel.findOne({
      token: resetToken,
      isUsed: false
    });
    if (!token) {
      throw new BadRequestException("Invalid or expired reset token");
    }
    if (token.expiresAt < new Date()) {
      await this.resetTokenModel.deleteOne({ token: resetToken });
      throw new BadRequestException("Reset token has expired");
    }
    const user = await this.userModel.findById(token.userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    user.password = newPassword;
    await user.save();
    await this.resetTokenModel.updateOne(
      { token: resetToken },
      { isUsed: true }
    );
    await this.revokeAllUserRefreshTokens(user._id.toString());
    await this.invalidateUserCache(user.id.toString());
    return { message: "Password has been reset successfully. Please login again." };
  }
}
