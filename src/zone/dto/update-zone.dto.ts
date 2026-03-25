// update-zone.dto.ts
import { IsBoolean, IsOptional, IsString } from "class-validator";
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

  @ApiProperty({ description: "Zone có ghế ngồi hay không", required: false })
  @IsOptional()
  @IsBoolean()
  hasSeating?: boolean;

  @IsBoolean()
  @IsOptional()
  isDeleted?: boolean;
}
