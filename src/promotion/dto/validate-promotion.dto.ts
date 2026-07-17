import { ApiProperty } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsInt, IsMongoId, IsString, MaxLength, Min } from "class-validator";

export class ValidatePromotionDto {
  @ApiProperty({ example: "SUMMER20" })
  @IsString()
  @MaxLength(64)
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  code: string;

  @ApiProperty()
  @IsMongoId()
  eventId: string;

  @ApiProperty()
  @IsMongoId()
  zoneId: string;

  @ApiProperty({ description: "Order amount before discount, in VND." })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  orderAmount: number;
}
