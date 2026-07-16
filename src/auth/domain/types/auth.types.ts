import { Request } from "express";
import { Types } from "mongoose";

export type GoogleProfile = {
  email?: string;
  name?: string;
  picture?: string;
};

export interface SessionRequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

export interface SessionSummary {
  id: string;
  deviceInfo: string | null;
  ipAddress: string | null;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
  isCurrent: boolean;
}

export interface AuthMessageResult {
  message: string;
}

export interface AuthTokenPair {
  accessToken: string;
  refreshToken: string;
}

export interface TwoFactorRequiredResult {
  status: "requires2fa";
  twoFactorToken: string;
}

export type LoginResult = AuthMessageResult | TwoFactorRequiredResult;
export type CurrentUserResult = Request["currentUser"];

export interface AuthUserSource {
  _id?: Types.ObjectId | string;
  id?: string;
  email?: string;
  fullName?: string;
  phoneNumber?: string;
  role?: string;
  isVerified?: boolean;
  isActive?: boolean;
  twoFactorEnabled?: boolean;
  avatarPublicId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ActiveAuthUser {
  _id: Types.ObjectId | string;
  role: string;
  isActive: boolean;
}

export interface AuthUserProfile {
  id: string;
  email?: string;
  fullName?: string;
  phoneNumber?: string;
  role?: string;
  isVerified: boolean;
  isActive: boolean;
  twoFactorEnabled: boolean;
  avatarUrl: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type SessionLean = {
  _id: Types.ObjectId;
  refreshTokenHash: string;
  deviceInfo?: string;
  ipAddress?: string;
  lastUsedAt: Date;
  createdAt: Date;
  expiresAt: Date;
};
