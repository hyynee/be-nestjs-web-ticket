import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsMongoId,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { PromotionType } from "@src/schemas/promotion.schema";

const normalizeCode = ({ value }: { value: unknown }): unknown =>
  typeof value === "string" ? value.trim().toUpperCase() : value;

export class CreatePromotionDto {
  @ApiProperty({ example: "SUMMER20" })
  @IsString()
  @MaxLength(64)
  @Transform(normalizeCode)
  code: string;

  @ApiProperty({ enum: PromotionType })
  @IsEnum(PromotionType)
  type: PromotionType;

  @ApiProperty({ description: "Percent 1-100 or fixed VND amount." })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  value: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsMongoId({ each: true })
  eventIds?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @IsMongoId({ each: true })
  zoneIds?: string[];

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  startsAt: Date;

  @ApiProperty()
  @Type(() => Date)
  @IsDate()
  endsAt: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUses?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  maxUsesPerUser?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minOrderAmount?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @Transform(({ value }) =>
    value === undefined ? undefined : value === true || value === "true"
  )
  isActive?: boolean;
}
