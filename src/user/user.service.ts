import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { Model, Types } from "mongoose";
import { QueryUserDTO } from "./dto/query-user.dto";
import { Payment } from "@src/schemas/payment.schema";

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>
  ) { }

  private async calculateSpending(
    userId: string,
    startDate?: Date,
    endDate?: Date
  ) {
    if (!userId) {
      throw new NotFoundException("User ID is required");
    }

    const matchCondition: any = {
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

  async getTotalUserSpending(userId: string) {
    const totalSpending = await this.calculateSpending(userId);

    return {
      totalSpending,
      message: "Total spending retrieved successfully",
    };
  }

  async getTotalUserSpendingInYear(userId: string, year: number) {
    const startOfYear = new Date(year, 0, 1, 0, 0, 0);
    const endOfYear = new Date(year, 11, 31, 23, 59, 59);

    const totalSpending = await this.calculateSpending(
      userId,
      startOfYear,
      endOfYear
    );

    return {
      totalSpending,
      year,
      message: "Total spending retrieved successfully",
    };
  }

  async getTotalUserSpendingInMonth(
    userId: string,
    month: number,
    year: number
  ) {
    const startOfMonth = new Date(year, month - 1, 1, 0, 0, 0);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59);

    const totalSpending = await this.calculateSpending(
      userId,
      startOfMonth,
      endOfMonth
    );

    return {
      totalSpending,
      month,
      year,
      message: "Total spending retrieved successfully",
    };
  }

  async getTotalUserSpendingInDay(
    userId: string,
    day: number,
    month: number,
    year: number
  ) {
    const startOfDay = new Date(year, month - 1, day, 0, 0, 0);
    const endOfDay = new Date(year, month - 1, day, 23, 59, 59);

    const totalSpending = await this.calculateSpending(
      userId,
      startOfDay,
      endOfDay
    );

    return {
      totalSpending,
      day,
      month,
      year,
      message: "Total spending retrieved successfully",
    };
  }

  async getAllUser(query: QueryUserDTO) {
    const { search, page = 1, limit = 10 } = query;
    const skip = (page - 1) * limit;
    const filter: any = {};

    if (search) {
      filter.$or = [{ email: { $regex: search, $options: "i" } }];
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
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);

    return {
      data: users,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUserById(id: string) {
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new NotFoundException("User not found");
    }
    return user;
  }
}