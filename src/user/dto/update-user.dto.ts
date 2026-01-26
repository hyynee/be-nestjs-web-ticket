import { IsOptional, IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';


export class UpdateUserDto {
    @ApiProperty({ required: false, description: "User's full name" })
    @IsOptional()
    @IsString()
    fullName?: string;
    @ApiProperty({ required: false, description: "User's phone number" })
    @IsOptional()
    @IsString()
    phoneNumber?: string;
    @ApiProperty({ required: false, description: "Public ID of the user's avatar image" })
    @IsOptional()
    @IsString()
    avatarPublicId?: string | null;
}