import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator";

export class CreateRefundRequestDto {
  @ApiProperty({ example: "BK202607170414532B0856D1" })
  @IsString()
  bookingCode: string;

  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({
    minimum: 1,
    description:
      "Optional partial refund amount in VND. Defaults to full refundable amount.",
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  amount?: number;
}
