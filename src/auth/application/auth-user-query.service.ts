import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { Model } from "mongoose";
import { Request } from "express";
import {
  AuthMessageResult,
  AuthUserProfile,
  AuthUserSource,
  CurrentUserResult,
} from "../domain/types/auth.types";
import { AuthUserCacheService } from "../infrastructure/cache/auth-user-cache.service";
import { AuthPresenter } from "../presenters/auth.presenter";

@Injectable()
export class AuthUserQueryService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    private readonly authUserCacheService: AuthUserCacheService,
    private readonly authPresenter: AuthPresenter
  ) {}

  status(): AuthMessageResult {
    return this.authPresenter.message("Logged in successfully");
  }

  getCurrentUser(req: Request): CurrentUserResult {
    return req.currentUser;
  }

  async getUserById(id: string): Promise<AuthUserProfile | null> {
    let user = await this.authUserCacheService.getUserDetails(id);
    if (!user) {
      user = await this.userModel
        .findById(id)
        .select(
          "email fullName phoneNumber role isVerified isActive twoFactorEnabled avatarPublicId createdAt updatedAt"
        )
        .lean<AuthUserSource>();
      if (!user) return null;
      await this.authUserCacheService.setUserDetails(id, user);
    }
    return this.authPresenter.toAuthUserProfile(user);
  }
}
