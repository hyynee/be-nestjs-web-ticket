import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches, MinLength } from "class-validator";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";

export class ResetPasswordDto {
  @ApiProperty({ example: "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11" })
  @IsNotEmpty()
  @IsString()
  @Matches(UUID_V4_REGEX, { message: "Invalid reset token format" })
  resetToken: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @MinLength(8, { message: "Password must be at least 8 characters long" })
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/, {
    message:
      "Password must contain uppercase, lowercase, number and special character",
  })
  newPassword: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  confirmPassword: string;
}
