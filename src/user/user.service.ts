import { Injectable, NotFoundException, Inject } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { FilterQuery, Model, Types } from "mongoose";
import { QueryUserDTO } from "./dto/query-user.dto";
import { Payment } from "@src/schemas/payment.schema";
import { UpdateUserDto } from "./dto/update-user.dto";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { escapeRegex } from "@src/common/utils/regex.utils";

const USER_RESPONSE_SCHEMA_VERSION = "v1";
const USER_SPENDING_MESSAGE = "Total spending retrieved successfully";

export interface UserSpendingResult {
  totalSpending: number;
  message: string;
}

export interface UserYearSpendingResult extends UserSpendingResult {
  year: number;
}

export interface UserMonthSpendingResult extends UserYearSpendingResult {
  month: number;
}

export interface UserDaySpendingResult extends UserMonthSpendingResult {
  day: number;
}

export interface UserListResult {
  data: UserProfile[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface UserProfileSource {
  _id?: Types.ObjectId | string;
  id?: string;
  email?: string;
  fullName?: string;
  phoneNumber?: string;
  role?: string;
  isVerified?: boolean;
  isActive?: boolean;
  twoFactorEnabled?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UserProfile {
  id: string;
  email?: string;
  fullName?: string;
  phoneNumber?: string;
  role?: string;
  isVerified: boolean;
  isActive: boolean;
  twoFactorEnabled: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UserAvatarReference {
  avatarPublicId?: string | null;
}

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache
  ) {}
  private generateCacheKeyForUser(userId: string): string {
    return `user:details:${USER_RESPONSE_SCHEMA_VERSION}:${userId}`;
  }

  private userSpending(totalSpending: number): UserSpendingResult {
    return {
      totalSpending,
      message: USER_SPENDING_MESSAGE,
    };
  }

  private userYearSpending(
    totalSpending: number,
    year: number
  ): UserYearSpendingResult {
    return {
      ...this.userSpending(totalSpending),
      year,
    };
  }

  private userMonthSpending(
    totalSpending: number,
    month: number,
    year: number
  ): UserMonthSpendingResult {
    return {
      ...this.userYearSpending(totalSpending, year),
      month,
    };
  }

  private userDaySpending(
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

  private userListResult(input: {
    users: UserProfileSource[];
    total: number;
    page: number;
    limit: number;
  }): UserListResult {
    return {
      data: input.users.map((user) => this.toUserProfile(user)),
      total: input.total,
      page: Number(input.page),
      limit: Number(input.limit),
      totalPages: Math.ceil(input.total / input.limit),
    };
  }

  private avatarReference(user: UserAvatarReference): UserAvatarReference {
    return { avatarPublicId: user.avatarPublicId ?? null };
  }

  private toUserProfile(user: UserProfileSource): UserProfile {
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

  async updateProfileUser(
    userId: string,
    data: UpdateUserDto
  ): Promise<UserProfile> {
    const updatedUser = await this.userModel
      .findByIdAndUpdate(userId, { $set: data }, { new: true })
      .select(
        "email fullName phoneNumber role isVerified isActive twoFactorEnabled createdAt updatedAt"
      );
    if (!updatedUser) {
      throw new NotFoundException("User not found");
    }
    const cacheKey = this.generateCacheKeyForUser(userId);
    await this.cacheManager.del(cacheKey);

    return this.toUserProfile(updatedUser);
  }

  private async calculateSpending(
    userId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    if (!userId) {
      throw new NotFoundException("User ID is required");
    }

    const matchCondition: FilterQuery<Payment> = {
      userId: new Types.ObjectId(userId),
      status: "succeeded",
      isDeleted: false,
      paidAt: { $ne: null },
    };

    // filter
    if (startDate && endDate) {
      matchCondition.paidAt = {
        ...matchCondition.paidAt,
        $gte: startDate,
        $lte: endDate,
      };
    }

    const result = await this.paymentModel.aggregate([
      { $match: matchCondition },
      {
        $group: {
          _id: null,
          totalSpending: { $sum: "$amount" },
        },
      },
    ]);

    return result[0]?.totalSpending ?? 0;
  }

  async getTotalUserSpending(userId: string): Promise<UserSpendingResult> {
    const totalSpending = await this.calculateSpending(userId);

    return this.userSpending(totalSpending);
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

    return this.userYearSpending(totalSpending, year);
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

    return this.userMonthSpending(totalSpending, month, year);
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

    return this.userDaySpending(totalSpending, day, month, year);
  }

  async getAllUser(query: QueryUserDTO): Promise<UserListResult> {
    const { search, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;
    const filter: FilterQuery<User> = {};

    if (search) {
      filter.$or = [
        { email: { $regex: escapeRegex(search.trim()), $options: "i" } },
      ];
    }
    if (query.isActive !== undefined) {
      filter.isActive = query.isActive;
    }
    if (query.role) {
      filter.role = query.role;
    }

    const [users, total] = await Promise.all([
      this.userModel
        .find(filter)
        .select(
          "email fullName phoneNumber role isVerified isActive twoFactorEnabled createdAt updatedAt"
        )
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<UserProfileSource[]>()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return this.userListResult({ users, total, page, limit });
  }

  async getUserById(id: string): Promise<UserProfile> {
    const user = await this.userModel
      .findById(id)
      .select(
        "email fullName phoneNumber role isVerified isActive twoFactorEnabled createdAt updatedAt"
      );
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return this.toUserProfile(user);
  }

  async getUserAvatarReference(id: string): Promise<UserAvatarReference> {
    const user = await this.userModel
      .findById(id)
      .select("avatarPublicId")
      .lean<UserAvatarReference>()
      .exec();
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return this.avatarReference(user);
  }
}
