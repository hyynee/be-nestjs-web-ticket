import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { UserEventsService } from "@src/events/user-event.services";
import { EmailVerificationToken } from "@src/schemas/email-verification-token.schema";
import { User } from "@src/schemas/user.schema";
import { Model } from "mongoose";
import * as crypto from "crypto";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { Logger } from "winston";
import { EMAIL_VERIFICATION_TOKEN_TTL_MS } from "../auth.constants";
import { RegisterDTO } from "../dto/create.dto";
import { VerifyEmailDto } from "../dto/verify-email.dto";
import {
  AuthMessageResult,
  AuthUserProfile,
  AuthUserSource,
} from "../domain/types/auth.types";
import {
  hasToObject,
  isDuplicateKeyError,
} from "../domain/utils/auth-document.utils";
import { AuthUserCacheService } from "../infrastructure/cache/auth-user-cache.service";
import { AuthTokenService } from "../infrastructure/security/auth-token.service";
import { AuthPresenter } from "../presenters/auth.presenter";

@Injectable()
export class AuthAccountService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(EmailVerificationToken.name)
    private readonly emailVerificationTokenModel: Model<EmailVerificationToken>,
    @Inject(WINSTON_MODULE_PROVIDER) private readonly logger: Logger,
    private readonly userEventsService: UserEventsService,
    private readonly authUserCacheService: AuthUserCacheService,
    private readonly authTokenService: AuthTokenService,
    private readonly authPresenter: AuthPresenter
  ) {}

  async register(data: RegisterDTO): Promise<AuthUserProfile> {
    const { email, password, confirmPassword, fullName } = data;
    if (password !== confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }

    const rawVerificationToken = crypto.randomBytes(32).toString("hex");
    const session = await this.userModel.db.startSession();
    let createdUser!: User;

    try {
      await session.withTransaction(async () => {
        const user = new this.userModel({
          email,
          password,
          fullName,
          role: "user",
        });

        try {
          createdUser = (await user.save({ session })) || user;
        } catch (err: unknown) {
          if (isDuplicateKeyError(err)) {
            throw new ConflictException("Email already exists");
          }
          throw err;
        }

        const tokenHash = this.authTokenService.hashToken(rawVerificationToken);
        const expiresAt = new Date(
          Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS
        );

        await this.emailVerificationTokenModel.create(
          [{ userId: createdUser._id, tokenHash, expiresAt }],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    this.userEventsService.emitUserRegistered(createdUser);
    this.userEventsService.emitEmailVerificationRequested(
      createdUser.email,
      rawVerificationToken,
      createdUser.fullName
    );

    const source = hasToObject(createdUser)
      ? (createdUser.toObject() as AuthUserSource)
      : (createdUser as AuthUserSource);
    const profile = this.authPresenter.toAuthUserProfile(source);
    if (!profile) {
      throw new ServiceUnavailableException("Created user profile is invalid");
    }
    return profile;
  }

  async verifyEmail(data: VerifyEmailDto): Promise<AuthMessageResult> {
    const tokenHash = this.authTokenService.hashToken(data.token);

    const session = await this.emailVerificationTokenModel.db.startSession();
    let verifiedUserId: string | undefined;

    try {
      await session.withTransaction(async () => {
        const verificationToken =
          await this.emailVerificationTokenModel.findOneAndUpdate(
            { tokenHash, isUsed: false, expiresAt: { $gt: new Date() } },
            { isUsed: true },
            { session }
          );

        if (!verificationToken) {
          const existing = await this.emailVerificationTokenModel
            .findOne({ tokenHash })
            .session(session);
          if (!existing) {
            throw new BadRequestException(
              "Invalid or expired verification token"
            );
          }
          if (existing.isUsed) {
            throw new BadRequestException(
              "Verification token has already been used"
            );
          }
          throw new BadRequestException("Verification token has expired");
        }

        const user = await this.userModel.findByIdAndUpdate(
          verificationToken.userId,
          { isVerified: true },
          { new: true, session }
        );
        if (!user) {
          throw new NotFoundException("User not found");
        }

        verifiedUserId = user._id.toString();
      });
    } finally {
      await session.endSession();
    }

    await this.authUserCacheService.invalidateUser(verifiedUserId!);
    this.logger.info(`auth.email_verified - userId=${verifiedUserId}`);

    return this.authPresenter.message("Email verified successfully.");
  }

  async resendVerificationEmail(email: string): Promise<AuthMessageResult> {
    const genericResponse = this.authPresenter.message(
      "If that email address is registered and not yet verified, we have sent a new verification link to it."
    );

    const user = await this.userModel.findOne({ email });
    if (!user || user.isVerified) {
      return genericResponse;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = this.authTokenService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);

    const session = await this.emailVerificationTokenModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        await this.emailVerificationTokenModel.deleteMany(
          { userId: user._id },
          { session }
        );
        await this.emailVerificationTokenModel.create(
          [{ userId: user._id, tokenHash, expiresAt }],
          { session }
        );
      });
    } finally {
      await session.endSession();
    }

    this.userEventsService.emitEmailVerificationRequested(
      user.email,
      rawToken,
      user.fullName
    );

    return genericResponse;
  }
}
