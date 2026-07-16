import { Injectable } from "@nestjs/common";
import { v2 as cloudinary } from "cloudinary";
import {
  AuthMessageResult,
  AuthTokenPair,
  AuthUserProfile,
  AuthUserSource,
  SessionLean,
  SessionSummary,
  TwoFactorRequiredResult,
} from "../domain/types/auth.types";

@Injectable()
export class AuthPresenter {
  message(message: string): AuthMessageResult {
    return { message };
  }

  twoFactorRequired(twoFactorToken: string): TwoFactorRequiredResult {
    return { status: "requires2fa", twoFactorToken };
  }

  tokenPair(accessToken: string, refreshToken: string): AuthTokenPair {
    return { accessToken, refreshToken };
  }

  toAuthUserProfile(user: AuthUserSource): AuthUserProfile | null {
    const userId = user._id?.toString() ?? user.id;
    if (!userId) {
      return null;
    }

    const avatarUrl = user.avatarPublicId
      ? cloudinary.url(user.avatarPublicId, {
          type: "private",
          sign_url: true,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          secure: true,
        })
      : null;

    return {
      id: userId,
      email: user.email,
      fullName: user.fullName,
      phoneNumber: user.phoneNumber,
      role: user.role,
      isVerified: user.isVerified ?? false,
      isActive: user.isActive ?? true,
      twoFactorEnabled: user.twoFactorEnabled ?? false,
      avatarUrl,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    };
  }

  toSessionSummary(session: SessionLean, currentHash?: string): SessionSummary {
    return {
      id: session._id.toString(),
      deviceInfo: session.deviceInfo ?? null,
      ipAddress: session.ipAddress ?? null,
      lastUsedAt: session.lastUsedAt,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      isCurrent: currentHash ? session.refreshTokenHash === currentHash : false,
    };
  }
}
