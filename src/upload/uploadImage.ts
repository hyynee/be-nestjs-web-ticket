import {
  Controller,
  Post,
  Get,
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

const storage = multer.memoryStorage();

@Controller('upload')
export class UploadController {
  constructor() {
    cloudinary.config({
      cloud_name: config.CLOUDINARY_CLOUD_NAME,
      api_key: config.CLOUDINARY_API_KEY,
      api_secret: config.CLOUDINARY_API_SECRET,
    });
  }
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin'])) 
  @Post('private')
  @UseInterceptors(FileInterceptor('image', { storage }))
  // npm install -D @types/multer
  async uploadPrivateImage(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new HttpException('No file uploaded', HttpStatus.BAD_REQUEST);
    }

    // Validate file
    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedMimeTypes.includes(file.mimetype)) {
      throw new HttpException('Invalid file type', HttpStatus.BAD_REQUEST);
    }

    try {
      // 'private'
      const uploadResult: any = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'image',
            type: 'private', // Ảnh private
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

      const expiresIn = 24 * 3600; // 24 giờ
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
  // API refresh URL (khi URL cũ hết hạn)
  @UseGuards(AuthGuard('jwt'))
  @Get('refresh-url/:publicId')
  async refreshSignedUrl(@Param('publicId') publicId: string) {
    try {
      const expiresIn = 24 * 3600; // 24 giờ
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
}