import { Injectable, NotFoundException } from "@nestjs/common";
import {
  UserAvatarReference,
  UserDaySpendingResult,
  UserListResult,
  UserMonthSpendingResult,
  UserPageSource,
  UserProfile,
  UserProfileSource,
  UserSpendingResult,
  UserYearSpendingResult,
} from "../domain/types/user.types";

const USER_SPENDING_MESSAGE = "Total spending retrieved successfully";

@Injectable()
export class UserPresenter {
  userSpending(totalSpending: number): UserSpendingResult {
    return {
      totalSpending,
      message: USER_SPENDING_MESSAGE,
    };
  }

  userYearSpending(
    totalSpending: number,
    year: number
  ): UserYearSpendingResult {
    return {
      ...this.userSpending(totalSpending),
      year,
    };
  }

  userMonthSpending(
    totalSpending: number,
    month: number,
    year: number
  ): UserMonthSpendingResult {
    return {
      ...this.userYearSpending(totalSpending, year),
      month,
    };
  }

  userDaySpending(
    totalSpending: number,
    day: number,
    month: number,
    year: number
  ): UserDaySpendingResult {
    return {
      ...this.userMonthSpending(totalSpending, month, year),
      day,
    };
  }

  userListResult(input: UserPageSource): UserListResult {
    return {
      data: input.users.map((user) => this.toUserProfile(user)),
      total: input.total,
      page: Number(input.page),
      limit: Number(input.limit),
      totalPages: Math.ceil(input.total / input.limit),
    };
  }

  avatarReference(user: UserAvatarReference): UserAvatarReference {
    return { avatarPublicId: user.avatarPublicId ?? null };
  }

  toUserProfile(user: UserProfileSource): UserProfile {
    const id = user._id?.toString() ?? user.id;
    if (!id) {
      throw new NotFoundException("User ID is missing");
    }

    return {
      id,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      role: user.role,
      isVerified: user.isVerified ?? false,
      isActive: user.isActive ?? true,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }
}
