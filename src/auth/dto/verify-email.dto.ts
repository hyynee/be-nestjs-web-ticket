import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString, Matches } from "class-validator";
import { HEX_TOKEN_64_REGEX } from "@src/common/utils/regex.utils";

export class VerifyEmailDto {
  @ApiProperty({
    description: "Raw email verification token sent to the user's inbox",
  })
  @IsString()
  @IsNotEmpty()
  @Matches(HEX_TOKEN_64_REGEX, { message: "Invalid verification token format" })
  token: string;
}
