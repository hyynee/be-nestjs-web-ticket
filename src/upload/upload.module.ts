import { Module } from '@nestjs/common';
import { UploadController } from './uploadImage';
import { UserModule } from '@src/user/user.module';
import { UploadService } from './upload.service';

@Module({
  imports: [UserModule],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService], 
})
export class UploadModule {}