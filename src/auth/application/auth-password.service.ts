import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { UserEventsService } from "@src/events/user-event.services";
import { ResetToken } from "@src/schemas/reset-token.schema";
import { User } from "@src/schemas/user.schema";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";
import { Model } from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { ChangePasswordDTO } from "../dto/password.dto";
import { ResetPasswordDto } from "../dto/reset-password.dto";
import { AuthMessageResult } from "../domain/types/auth.types";
import { withPassword } from "../domain/utils/auth-document.utils";
import { AuthUserCacheService } from "../infrastructure/cache/auth-user-cache.service";
import { AuthPresenter } from "../presenters/auth.presenter";
import { AuthSessionService } from "./auth-session.service";

const RESET_PASSWORD_TOKEN_TTL_MS = 60 * 60 * 1000;

@Injectable()
export class AuthPasswordService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(ResetToken.name)
    private readonly resetTokenModel: Model<ResetToken>,
    private readonly userEventsService: UserEventsService,
    private readonly authUserCacheService: AuthUserCacheService,
    private readonly authSessionService: AuthSessionService,
    private readonly authPresenter: AuthPresenter
  ) {}

  async changePassword(
    userId: string,
    data: ChangePasswordDTO
  ): Promise<AuthMessageResult> {
    const { oldPassword, newPassword } = data;
    const user = await withPassword(this.userModel.findById(userId));
    if (!user) {
      throw new NotFoundException("User not found");
    }
    const isMatch = await user.comparePassword(oldPassword);
    if (!isMatch) {
      throw new UnauthorizedException("Invalid old password");
    }
    user.password = newPassword;
    await user.save();
    await Promise.all([
      this.authSessionService.revokeAllUserSessions(userId),
      this.authUserCacheService.invalidateUser(userId),
    ]);
    return this.authPresenter.message("Password changed successfully");
  }

  async forgotPassword(email: string): Promise<AuthMessageResult> {
    const genericResponse = this.authPresenter.message(
      "If that email address is in our system, we have sent a password reset link to it."
    );

    const user = await this.userModel.findOne({ email });
    if (!user) {
      return genericResponse;
    }

    const resetToken = uuidv4();
    const expiresAt = new Date(Date.now() + RESET_PASSWORD_TOKEN_TTL_MS);

    const session = await this.resetTokenModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.resetTokenModel.deleteMany(
          { userId: user._id, isUsed: false },
          { session }
        );
        await this.resetTokenModel.create(
          [{ userId: user._id, token: resetToken, expiresAt, isUsed: false }],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    this.userEventsService.emitPasswordResetRequested(
      user.email,
      resetToken,
      user.fullName
    );
    return genericResponse;
  }

  async resetPassword(data: ResetPasswordDto): Promise<AuthMessageResult> {
    const { resetToken, newPassword, confirmPassword } = data;

    if (newPassword !== confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }

    if (!UUID_V4_REGEX.test(resetToken)) {
      throw new BadRequestException("Invalid or expired reset token");
    }

    const token = await this.resetTokenModel.findOneAndUpdate(
      {
        token: resetToken,
        isUsed: false,
        expiresAt: { $gt: new Date() },
      },
      { isUsed: true }
    );
    if (!token) {
      const existing = await this.resetTokenModel.findOne({
        token: resetToken,
      });
      if (!existing) {
        throw new BadRequestException("Invalid or expired reset token");
      }
      if (existing.isUsed) {
        throw new BadRequestException("Reset token has already been used");
      }
      throw new BadRequestException("Reset token has expired");
    }
    const user = await this.userModel.findById(token.userId);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    user.password = newPassword;
    await user.save();
    const userId = user._id.toString();
    await this.authSessionService.revokeAllUserSessions(userId);
    await this.authUserCacheService.invalidateUser(userId);
    return this.authPresenter.message(
      "Password has been reset successfully. Please login again."
    );
  }
}
