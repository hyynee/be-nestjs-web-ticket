import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { Payment } from "@src/schemas/payment.schema";
import { User } from "@src/schemas/user.schema";
import { QueryUserDTO } from "@src/user/dto/query-user.dto";
import { UpdateUserDto } from "@src/user/dto/update-user.dto";
import {
  UserAvatarReference,
  UserPageSource,
  UserProfileSource,
} from "@src/user/domain/types/user.types";
import { FilterQuery, Model, Types } from "mongoose";

const USER_PROFILE_SELECT =
  "email fullName phoneNumber role isVerified isActive twoFactorEnabled createdAt updatedAt";

interface UserSpendingSource {
  totalSpending: number;
}

@Injectable()
export class UserRepository {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>
  ) {}

  updateProfileUser(
    userId: string,
    data: UpdateUserDto
  ): Promise<UserProfileSource | null> {
    return this.userModel
      .findByIdAndUpdate(userId, { $set: data }, { new: true })
      .select(USER_PROFILE_SELECT);
  }

  async calculateSpending(
    userId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<number> {
    const matchCondition: FilterQuery<Payment> = {
      userId: new Types.ObjectId(userId),
      status: "succeeded",
      isDeleted: false,
      paidAt: { $ne: null },
    };

    if (startDate && endDate) {
      matchCondition.paidAt = {
        ...matchCondition.paidAt,
        $gte: startDate,
        $lte: endDate,
      };
    }

    const result = await this.paymentModel.aggregate<UserSpendingSource>([
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

  async findUsersPage(query: QueryUserDTO): Promise<UserPageSource> {
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
        .select(USER_PROFILE_SELECT)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<UserProfileSource[]>()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return { users, total, page, limit };
  }

  findUserProfileById(id: string): Promise<UserProfileSource | null> {
    return this.userModel.findById(id).select(USER_PROFILE_SELECT);
  }

  findUserAvatarReference(id: string): Promise<UserAvatarReference | null> {
    return this.userModel
      .findById(id)
      .select("avatarPublicId")
      .lean<UserAvatarReference>()
      .exec();
  }
}
