import { Injectable, NotFoundException } from "@nestjs/common";
import { QueryUserDTO } from "./dto/query-user.dto";
import { UpdateUserDto } from "./dto/update-user.dto";
import {
  UserAvatarReference,
  UserDaySpendingResult,
  UserListResult,
  UserMonthSpendingResult,
  UserProfile,
  UserSpendingResult,
  UserYearSpendingResult,
} from "./domain/types/user.types";
import { UserCacheService } from "./infrastructure/cache/user-cache.service";
import { UserRepository } from "./infrastructure/persistence/user.repository";
import { UserPresenter } from "./presenters/user.presenter";

export type {
  UserAvatarReference,
  UserDaySpendingResult,
  UserListResult,
  UserMonthSpendingResult,
  UserProfile,
  UserSpendingResult,
  UserYearSpendingResult,
} from "./domain/types/user.types";

@Injectable()
export class UserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userCache: UserCacheService,
    private readonly userPresenter: UserPresenter
  ) {}

  async updateProfileUser(
    userId: string,
    data: UpdateUserDto
  ): Promise<UserProfile> {
    const updatedUser = await this.userRepository.updateProfileUser(
      userId,
      data
    );
    if (!updatedUser) {
      throw new NotFoundException("User not found");
    }
    await this.userCache.deleteUserDetails(userId);

    return this.userPresenter.toUserProfile(updatedUser);
  }

  async getTotalUserSpending(userId: string): Promise<UserSpendingResult> {
    const totalSpending = await this.calculateSpending(userId);

    return this.userPresenter.userSpending(totalSpending);
  }

  async getTotalUserSpendingInYear(
    userId: string,
    year: number
  ): Promise<UserYearSpendingResult> {
    const startOfYear = new Date(year, 0, 1, 0, 0, 0);
    const endOfYear = new Date(year, 11, 31, 23, 59, 59);

    const totalSpending = await this.calculateSpending(
      userId,
      startOfYear,
      endOfYear
    );

    return this.userPresenter.userYearSpending(totalSpending, year);
  }

  async getTotalUserSpendingInMonth(
    userId: string,
    month: number,
    year: number
  ): Promise<UserMonthSpendingResult> {
    const startOfMonth = new Date(year, month - 1, 1, 0, 0, 0);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    const totalSpending = await this.calculateSpending(
      userId,
      startOfMonth,
      endOfMonth
    );

    return this.userPresenter.userMonthSpending(totalSpending, month, year);
  }

  async getTotalUserSpendingInDay(
    userId: string,
    day: number,
    month: number,
    year: number
  ): Promise<UserDaySpendingResult> {
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59);

    const totalSpending = await this.calculateSpending(
      userId,
      startOfDay,
      endOfDay
    );

    return this.userPresenter.userDaySpending(totalSpending, day, month, year);
  }

  async getAllUser(query: QueryUserDTO): Promise<UserListResult> {
    const page = await this.userRepository.findUsersPage(query);
    return this.userPresenter.userListResult(page);
  }

  async getUserById(id: string): Promise<UserProfile> {
    const user = await this.userRepository.findUserProfileById(id);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return this.userPresenter.toUserProfile(user);
  }

  async getUserAvatarReference(id: string): Promise<UserAvatarReference> {
    const user = await this.userRepository.findUserAvatarReference(id);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return this.userPresenter.avatarReference(user);
  }

  private calculateSpending(
    userId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    if (!userId) {
      throw new NotFoundException("User ID is required");
    }

    return this.userRepository.calculateSpending(userId, startDate, endDate);
  }
}
