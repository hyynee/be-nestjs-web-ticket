import {
  Controller,
  Post,
  Get,
  Delete,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpException,
  HttpStatus,
  Logger,
  Query,
} from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiCookieAuth } from "@nestjs/swagger";
import config from "@src/config/config";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import {
  UploadApiOptions,
  UploadApiResponse,
  v2 as cloudinary,
} from "cloudinary";
import * as multer from "multer";
import { UserService } from "@src/user/user.service";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { getErrorMessage } from "@src/helper/getErrorMessage";

const storage = multer.memoryStorage();
const PRIVATE_IMAGE_EXPIRES_IN_SECONDS = 24 * 3600;
const AVATAR_EXPIRES_IN_SECONDS = 3600;

interface AvatarReference {
  avatarPublicId: string | null;
}

interface AvatarLookupResult {
  avatarPublicId?: string | null;
}

interface AvatarLookupService {
  getUserAvatarReference?: (userId: string) => Promise<AvatarLookupResult>;
  getUserById?: (userId: string) => Promise<AvatarLookupResult>;
}

function uploadImageBuffer(
  buffer: Buffer,
  options: UploadApiOptions
): Promise<UploadApiResponse> {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(
      options,
      (error, result) => {
        if (error) {
          const errorMessage =
            error instanceof Error ? error.message : "Cloudinary upload failed";
          reject(new Error(errorMessage));
          return;
        }

        if (!result) {
          reject(new Error("Cloudinary upload returned no result"));
          return;
        }

        resolve(result);
      }
    );
    uploadStream.end(buffer);
  });
}

@Controller("upload")
export class UploadController {
  private readonly logger = new Logger(UploadController.name);

  constructor(private readonly userService: UserService) {
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
    });
  }

  private async getAvatarReference(userId: string): Promise<AvatarReference> {
    const avatarLookupService = this.userService as AvatarLookupService;

    if (avatarLookupService.getUserAvatarReference) {
      const reference =
        await avatarLookupService.getUserAvatarReference(userId);
      return { avatarPublicId: reference.avatarPublicId ?? null };
    }

    const legacyUser = await avatarLookupService.getUserById?.(userId);
    return { avatarPublicId: legacyUser?.avatarPublicId ?? null };
  }

  // ==================== ADMIN ENDPOINTS ====================

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("private")
  @UseInterceptors(FileInterceptor("image", { storage }))
  async uploadPrivateImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException("No file uploaded", HttpStatus.BAD_REQUEST);
    }

    const allowedMimeTypes = [
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new HttpException("Invalid file type", HttpStatus.BAD_REQUEST);
    }

    try {
      const uploadResult = await uploadImageBuffer(file.buffer, {
        resource_type: "image",
        type: "private",
        folder: "private_uploads",
        access_mode: "authenticated",
      });

      const expiresIn = PRIVATE_IMAGE_EXPIRES_IN_SECONDS;
      const signedUrl = cloudinary.url(uploadResult.public_id, {
        type: "private",
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        message: "File uploaded successfully",
        data: {
          imageUrl: signedUrl,
          publicId: uploadResult.public_id,
          format: uploadResult.format,
          bytes: uploadResult.bytes,
          expiresIn: expiresIn,
          expiresAt: Date.now() + expiresIn * 1000,
        },
      };
    } catch (error) {
      console.error("Cloudinary upload error:", error);
      throw new HttpException(
        "File upload failed. Please try again.",
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("refresh-url")
  refreshSignedUrl(@Query("publicId") publicId: string) {
    if (!publicId) {
      throw new HttpException("publicId is required", HttpStatus.BAD_REQUEST);
    }

    try {
      const expiresIn = PRIVATE_IMAGE_EXPIRES_IN_SECONDS;
      const signedUrl = cloudinary.url(publicId, {
        type: "private",
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        data: {
          imageUrl: signedUrl,
          expiresIn: expiresIn,
          expiresAt: Date.now() + expiresIn * 1000,
        },
      };
    } catch (error) {
      this.logger.error(
        `UploadController: failed to generate signed image URL for publicId=${publicId}: ${getErrorMessage(error)}`
      );
      throw new HttpException(
        "Failed to generate signed URL",
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  // ==================== USER AVATAR ENDPOINTS ====================

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Post("avatar")
  @UseInterceptors(
    FileInterceptor("avatar", {
      storage,
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    })
  )
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload
  ) {
    const dbUser = await this.getAvatarReference(user.userId);

    if (!file) {
      throw new HttpException("No file uploaded", HttpStatus.BAD_REQUEST);
    }

    const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new HttpException(
        "Invalid file type. Only JPEG, PNG, WEBP allowed",
        HttpStatus.BAD_REQUEST
      );
    }

    try {
      if (dbUser.avatarPublicId) {
        try {
          await cloudinary.uploader.destroy(dbUser.avatarPublicId, {
            type: "private",
            resource_type: "image",
          });
        } catch (error) {
          console.error("Error deleting old avatar:", error);
        }
      }

      const uploadResult = await uploadImageBuffer(file.buffer, {
        resource_type: "image",
        type: "private",
        folder: `avatars/${user.userId}`,
        access_mode: "authenticated",
        transformation: [
          { width: 400, height: 400, crop: "fill", gravity: "face" },
          { quality: "auto:good" },
        ],
      });

      await this.userService.updateProfileUser(user.userId, {
        avatarPublicId: uploadResult.public_id,
      });

      const expiresIn = AVATAR_EXPIRES_IN_SECONDS;
      const avatarUrl = cloudinary.url(uploadResult.public_id, {
        type: "private",
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        message: "Avatar uploaded successfully",
        data: {
          avatarUrl,
          publicId: uploadResult.public_id,
          expiresIn,
        },
      };
    } catch (error) {
      console.error("Avatar upload error:", error);
      throw new HttpException(
        "Avatar upload failed. Please try again.",
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Delete("avatar")
  async deleteAvatar(@CurrentUser() user: JwtPayload) {
    const dbUser = await this.getAvatarReference(user.userId);

    if (!dbUser.avatarPublicId) {
      throw new HttpException("No avatar to delete", HttpStatus.BAD_REQUEST);
    }

    await cloudinary.uploader.destroy(dbUser.avatarPublicId, {
      type: "private",
      resource_type: "image",
    });

    await this.userService.updateProfileUser(user.userId, {
      avatarPublicId: null,
    });

    return {
      status: HttpStatus.OK,
      message: "Avatar deleted successfully",
    };
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Get("refresh-avatar-url")
  async refreshAvatarUrl(@CurrentUser() user: JwtPayload) {
    const dbUser = await this.getAvatarReference(user.userId);
    if (!dbUser.avatarPublicId) {
      throw new HttpException("User has no avatar", HttpStatus.BAD_REQUEST);
    }

    try {
      const expiresIn = 3600;
      const signedUrl = cloudinary.url(dbUser.avatarPublicId, {
        type: "private",
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        data: {
          avatarUrl: signedUrl,
          expiresIn: expiresIn,
          expiresAt: Date.now() + expiresIn * 1000,
        },
      };
    } catch (error) {
      this.logger.error(
        `UploadController: failed to generate signed avatar URL for userId=${user.userId}: ${getErrorMessage(error)}`
      );
      throw new HttpException(
        "Failed to generate signed URL",
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}
