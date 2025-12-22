import { ApiProperty } from "@nestjs/swagger";
import { IsEmail } from "class-validator";
import { Matches } from "class-validator";
import { MinLength } from "class-validator";
import { IsString } from "class-validator";
import { IsOptional } from "class-validator";

export class RegisterDTO {
  @ApiProperty()
  @IsString()
  fullName: string;

  @ApiProperty()
  @IsEmail()
  email: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/, {
    message:
      "Password must contain at least one uppercase letter, one lowercase letter, and one number",
  })
  password: string;

  @ApiProperty()
  @IsString()
  @MinLength(6)
  @Matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)[a-zA-Z\d]{6,}$/, {
    message:
      "Password must contain at least one uppercase letter, one lowercase letter, and one number",
  })
  confirmPassword: string;

  @IsOptional()
  @IsString()
  role?: string;
}
