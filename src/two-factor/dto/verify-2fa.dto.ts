import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches } from "class-validator";

// Accepts either a 6-digit TOTP code or a 10-char hex recovery code (both are valid proof of ownership).
const TWO_FACTOR_CODE_REGEX = /^[a-zA-Z0-9]{6,20}$/;

export class VerifyTwoFactorDto {
  @ApiProperty({
    description:
      "6-digit TOTP code from the authenticator app, or a recovery code",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(TWO_FACTOR_CODE_REGEX, {
    message: "Invalid OTP/recovery code format",
  })
  otp: string;
}
