import { Types } from "mongoose";

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

export interface UserProfileSource {
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

export interface UserListResult {
  data: UserProfile[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface UserAvatarReference {
  avatarPublicId?: string | null;
}

export interface UserPageSource {
  users: UserProfileSource[];
  total: number;
  page: number;
  limit: number;
}
