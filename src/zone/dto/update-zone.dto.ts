// update-zone.dto.ts
import { IsBoolean, IsInt, IsOptional, IsString, Min } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class UpdateZoneDto {
  @ApiProperty({ description: "ID sự kiện", required: false })
  @IsOptional()
  @IsString()
  eventId?: string;

  @IsOptional()
  @IsString()
  name?: string;

  @ApiProperty({ description: "Mô tả khu vực", required: false })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ description: "Sức chứa tối đa của zone", required: false })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  capacity?: number;

  @ApiProperty({ description: "Zone có ghế ngồi hay không", required: false })
  @IsOptional()
  @IsBoolean()
  hasSeating?: boolean;

  @IsBoolean()
  @IsOptional()
  isDeleted?: boolean;
}
