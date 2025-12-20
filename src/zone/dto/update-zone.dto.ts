// update-zone.dto.ts
import { IsBoolean, IsOptional } from "class-validator";

export class UpdateZoneDto {
  @IsBoolean()
  @IsOptional()
  isDeleted?: boolean;
}
