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
  @IsBoolean()
  @IsOptional()
  isDeleted?: boolean;
}
