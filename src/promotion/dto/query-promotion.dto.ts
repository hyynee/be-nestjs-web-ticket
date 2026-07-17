import { ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { PromotionType } from "@src/schemas/promotion.schema";

export class QueryPromotionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  code?: string;

  @ApiPropertyOptional({ enum: PromotionType })
  @IsOptional()
  @IsEnum(PromotionType)
  type?: PromotionType;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === true || value === "true"
  )
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  zoneId?: string;

  @ApiPropertyOptional({ default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ default: 20 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
