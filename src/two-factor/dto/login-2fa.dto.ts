import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches } from "class-validator";
import { UUID_V4_REGEX } from "@src/common/utils/regex.utils";

const TWO_FACTOR_CODE_REGEX = /^[a-zA-Z0-9]{6,20}$/;

export class LoginTwoFactorDto {
  @ApiProperty({
    description:
      "Opaque pending-login token returned by POST /auth/login when 2FA is required",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(UUID_V4_REGEX, { message: "Invalid two-factor login token format" })
  twoFactorToken: string;

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
