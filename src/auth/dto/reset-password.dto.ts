import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches, MinLength } from "class-validator";

export class ResetPasswordDto {
    @IsString()
    resetToken: string;

    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    @MinLength(8, { message: 'Password must be at least 8 characters long' })
    @Matches(
        /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/,
        { message: 'Password must contain uppercase, lowercase, number and special character' }
    )
    newPassword: string;
    
    @ApiProperty()
    @IsString()
    @IsNotEmpty()
    confirmPassword: string;
}