import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import * as crypto from "crypto";
import { authenticator } from "otplib";
import * as QRCode from "qrcode";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { User } from "@src/schemas/user.schema";
import envConfig from "@src/config/config";
import { encryptSecret, decryptSecret } from "@src/common/utils/crypto.utils";
import { TWO_FACTOR_RECOVERY_CODE_COUNT } from "@src/auth/auth.constants";

const TWO_FACTOR_ELIGIBLE_ROLES = ["admin", "organizer"];
const OTP_ISSUER = "TicketBE";
const SECRET_SELECT_FIELDS =
  "+twoFactorSecret +twoFactorRecoveryCodes role twoFactorEnabled email";

export interface TwoFactorSetupResult {
  secret: string;
  otpauthUrl: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}

@Injectable()
export class TwoFactorService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger
  ) {}

  private encryptionKey(): string {
    return envConfig.SECRET_KEY;
  }

  private assertEligibleRole(role: string): void {
    if (!TWO_FACTOR_ELIGIBLE_ROLES.includes(role)) {
      throw new ForbiddenException(
        "Two-factor authentication is only available for admin and organizer accounts"
      );
    }
  }

  private hashRecoveryCode(code: string): string {
    return crypto
      .createHash("sha256")
      .update(code.trim().toLowerCase())
      .digest("hex");
  }

  private generateRecoveryCodes(): { raw: string[]; hashed: string[] } {
    const raw: string[] = [];
    const hashed: string[] = [];
    for (let i = 0; i < TWO_FACTOR_RECOVERY_CODE_COUNT; i++) {
      const code = crypto.randomBytes(5).toString("hex");
      raw.push(code);
      hashed.push(this.hashRecoveryCode(code));
    }
    return { raw, hashed };
  }

  /** Starts (or restarts, if never confirmed) 2FA setup: generates a fresh TOTP secret + recovery codes. */
  async setup(userId: string): Promise<TwoFactorSetupResult> {
    const user = await this.userModel
      .findById(userId)
      .select(SECRET_SELECT_FIELDS);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    this.assertEligibleRole(user.role);
    if (user.twoFactorEnabled) {
      throw new ConflictException(
        "Two-factor authentication is already enabled. Disable it before setting up a new device."
      );
    }

    const secret = authenticator.generateSecret();
    const otpauthUrl = authenticator.keyuri(user.email, OTP_ISSUER, secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);
    const { raw, hashed } = this.generateRecoveryCodes();

    user.twoFactorSecret = encryptSecret(secret, this.encryptionKey());
    user.twoFactorRecoveryCodes = hashed;
    await user.save();

    return { secret, otpauthUrl, qrCodeDataUrl, recoveryCodes: raw };
  }

  /** Confirms setup by checking one real OTP from the freshly-scanned secret, then activates 2FA. */
  async confirmSetup(
    userId: string,
    otp: string
  ): Promise<{ message: string }> {
    const user = await this.userModel
      .findById(userId)
      .select(SECRET_SELECT_FIELDS);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    if (user.twoFactorEnabled) {
      throw new ConflictException(
        "Two-factor authentication is already enabled"
      );
    }
    if (!user.twoFactorSecret) {
      throw new BadRequestException(
        "No pending two-factor setup found — call POST /auth/2fa/setup first"
      );
    }

    const secret = decryptSecret(user.twoFactorSecret, this.encryptionKey());
    if (!authenticator.verify({ token: otp, secret })) {
      throw new UnauthorizedException("Invalid OTP code");
    }

    user.twoFactorEnabled = true;
    await user.save();
    this.logger.info(`auth.2fa_enabled — userId=${userId}`);

    return { message: "Two-factor authentication enabled successfully" };
  }

  async disable(userId: string, otp: string): Promise<{ message: string }> {
    const user = await this.userModel
      .findById(userId)
      .select(SECRET_SELECT_FIELDS);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    if (!user.twoFactorEnabled) {
      throw new BadRequestException("Two-factor authentication is not enabled");
    }

    const verified = await this.verifyOtpOrRecoveryCode(user, otp);
    if (!verified) {
      throw new UnauthorizedException("Invalid OTP or recovery code");
    }

    user.twoFactorEnabled = false;
    user.twoFactorSecret = undefined;
    user.twoFactorRecoveryCodes = [];
    await user.save();
    this.logger.info(`auth.2fa_disabled — userId=${userId}`);

    return { message: "Two-factor authentication disabled successfully" };
  }

  async regenerateRecoveryCodes(
    userId: string,
    otp: string
  ): Promise<{ recoveryCodes: string[] }> {
    const user = await this.userModel
      .findById(userId)
      .select(SECRET_SELECT_FIELDS);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    if (!user.twoFactorEnabled) {
      throw new BadRequestException("Two-factor authentication is not enabled");
    }

    const verified = await this.verifyOtpOrRecoveryCode(user, otp);
    if (!verified) {
      throw new UnauthorizedException("Invalid OTP or recovery code");
    }

    const { raw, hashed } = this.generateRecoveryCodes();
    user.twoFactorRecoveryCodes = hashed;
    await user.save();
    this.logger.info(`auth.2fa_recovery_codes_regenerated — userId=${userId}`);

    return { recoveryCodes: raw };
  }

  /** Used at login time, once the password has already been verified — checks TOTP first, falls back to a recovery code (single-use). */
  async verifyLoginOtp(userId: string, otp: string): Promise<boolean> {
    const user = await this.userModel
      .findById(userId)
      .select(SECRET_SELECT_FIELDS);
    if (!user || !user.twoFactorEnabled) {
      return false;
    }
    return this.verifyOtpOrRecoveryCode(user, otp);
  }

  private async verifyOtpOrRecoveryCode(
    user: User,
    otp: string
  ): Promise<boolean> {
    if (user.twoFactorSecret) {
      const secret = decryptSecret(user.twoFactorSecret, this.encryptionKey());
      if (authenticator.verify({ token: otp, secret })) {
        return true;
      }
    }

    const hashedInput = this.hashRecoveryCode(otp);

    // Atomic check-and-consume: the filter itself requires the code to still be present,
    // so two concurrent requests racing on the same recovery code can never both succeed —
    // only the one that actually removes it gets modifiedCount === 1.
    const result = await this.userModel.updateOne(
      { _id: user._id, twoFactorRecoveryCodes: hashedInput },
      { $pull: { twoFactorRecoveryCodes: hashedInput } }
    );
    return result.modifiedCount === 1;
  }
}
