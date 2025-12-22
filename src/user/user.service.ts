import { Injectable, UnauthorizedException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import { Model } from "mongoose";
import { QueryUserDTO } from "./dto/query-user.dto";

@Injectable()
export class UserService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>
  ) {}
  async getAllUser(query: QueryUserDTO) {
    const { search, page = 1, limit = 10 } = query;
    console.log("Query User:", query);
    const skip = (page - 1) * limit;
    const filter: any = { isDeleted: false };
    if (search) {
      filter.$or = [
        { username: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
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
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean()
        .exec(),
      this.userModel.countDocuments(filter).exec(),
    ]);
    console.log("Found users:", users);

    return {
      data: users,
      total,
      page: Number(page),
      limit: Number(limit),
      totalPages: Math.ceil(total / limit)
    };
  }
  async getUserById(id: string) {
    const user = await this.userModel.findById(id);
    if (!user) {
      throw new UnauthorizedException("User not found");
    }
    return user;
  }
}
