import { ApiProperty } from "@nestjs/swagger";
import { IsNotEmpty, IsString } from "class-validator";

export class RefreshTokenDTO {
  @ApiProperty({ example: "your_refresh_token_here" })
  @IsNotEmpty()
  @IsString()
  refreshToken: string;
}
