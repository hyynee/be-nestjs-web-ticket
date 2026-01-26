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
  Param,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth } from '@nestjs/swagger';
import config from '@src/config/config';
import { RolesGuard } from '@src/guards/role.guard';
import { v2 as cloudinary } from 'cloudinary';
import * as multer from 'multer';
import { UserService } from '@src/user/user.service';
import { CurrentUser } from '@src/auth/decorator/currentUser.decorator';
import { JwtPayload } from '@src/auth/dto/jwt-payload.dto';

const storage = multer.memoryStorage();

@Controller('upload')
export class UploadController {
  constructor(private readonly userService: UserService) {
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
    });
  }

  // ==================== ADMIN ENDPOINTS ====================
  
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  @Post('private')
  @UseInterceptors(FileInterceptor('image', { storage }))
  async uploadPrivateImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('No file uploaded', HttpStatus.BAD_REQUEST);
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new HttpException('Invalid file type', HttpStatus.BAD_REQUEST);
    }

    try {
      const uploadResult: any = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            type: 'private',
            folder: 'private_uploads',
            access_mode: 'authenticated',
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        uploadStream.end(file.buffer);
      });

      const expiresIn = 24 * 3600;
      const signedUrl = cloudinary.url(uploadResult.public_id, {
        type: 'private',
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        message: 'File uploaded successfully',
        data: {
          imageUrl: signedUrl,
          publicId: uploadResult.public_id,
          format: uploadResult.format,
          bytes: uploadResult.bytes,
          expiresIn: expiresIn,
          expiresAt: Date.now() + (expiresIn * 1000),
        },
      };
    } catch (error) {
      console.error('Cloudinary upload error:', error);
      throw new HttpException(
        `Upload failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  @Get('refresh-url/:publicId')
  async refreshSignedUrl(@Param('publicId') publicId: string) {
    try {
      const expiresIn = 24 * 3600;
      const signedUrl = cloudinary.url(publicId, {
        type: 'private',
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        data: {
          imageUrl: signedUrl,
          expiresIn: expiresIn,
          expiresAt: Date.now() + (expiresIn * 1000),
        },
      };
    } catch (error) {
      throw new HttpException(
        'Failed to generate signed URL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ==================== USER AVATAR ENDPOINTS ====================

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Post('avatar')
  @UseInterceptors(
    FileInterceptor('avatar', {
      storage,
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
      },
    }),
  )
  async uploadAvatar(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: JwtPayload,
  ) {
    const dbUser = await this.userService.getUserById(user.userId);

    if (!file) {
      throw new HttpException('No file uploaded', HttpStatus.BAD_REQUEST);
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new HttpException(
        'Invalid file type. Only JPEG, PNG, WEBP allowed',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      if (dbUser.avatarPublicId) {
        try {
          await cloudinary.uploader.destroy(dbUser.avatarPublicId, {
            type: 'private',
            resource_type: 'image',
          });
        } catch (error) {
          console.error('Error deleting old avatar:', error);
        }
      }

      // Upload avatar mới
      const uploadResult: any = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            type: 'private',
            folder: `avatars/${user.userId}`,
            access_mode: 'authenticated',
            transformation: [
              { width: 400, height: 400, crop: 'fill', gravity: 'face' },
              { quality: 'auto:good' },
            ],
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        );
        uploadStream.end(file.buffer);
      });

      await this.userService.updateProfileUser(user.userId, {
        avatarPublicId: uploadResult.public_id,
      });

      // Generate signed URL
      const expiresIn = 3600;
      const avatarUrl = cloudinary.url(uploadResult.public_id, {
        type: 'private',
        sign_url: true,
        expires_at: Math.floor(Date.now() / 1000) + expiresIn,
        secure: true,
      });

      return {
        status: HttpStatus.OK,
        message: 'Avatar uploaded successfully',
        data: {
          avatarUrl,
          publicId: uploadResult.public_id,
          expiresIn,
        },
      };
    } catch (error) {
      console.error('Avatar upload error:', error);
      throw new HttpException(
        `Upload failed: ${error.message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Delete('avatar')
async deleteAvatar(@CurrentUser() user: JwtPayload) {
  const dbUser = await this.userService.getUserById(user.userId);

  if (!dbUser.avatarPublicId) {
    throw new HttpException('No avatar to delete', HttpStatus.BAD_REQUEST);
  }

  await cloudinary.uploader.destroy(dbUser.avatarPublicId, {
    type: 'private',
    resource_type: 'image',
  });

  await this.userService.updateProfileUser(user.userId, {
    avatarPublicId: null,
  });

  return {
    status: HttpStatus.OK,
    message: 'Avatar deleted successfully',
  };
}


  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Get('refresh-avatar-url')
  async refreshAvatarUrl(@CurrentUser() user: JwtPayload) {
    const dbUser = await this.userService.getUserById(user.userId);
    if (!dbUser.avatarPublicId) {
      throw new HttpException('User has no avatar', HttpStatus.BAD_REQUEST);
    }

    try {
      const expiresIn = 3600;
      const signedUrl = cloudinary.url(dbUser.avatarPublicId, {
        type: 'private',
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
      throw new HttpException(
        'Failed to generate signed URL',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}