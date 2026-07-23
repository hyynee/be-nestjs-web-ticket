import { Type } from "class-transformer";
import { IsNumber, IsOptional, Max, Min } from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  ADMIN_OPS_DEFAULT_LIMIT,
  ADMIN_OPS_DEFAULT_PAGE,
  ADMIN_OPS_MAX_LIMIT,
} from "@src/admin-ops/admin-ops.constants";

export class AdminAnomalyQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: ADMIN_OPS_DEFAULT_PAGE })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page: number = ADMIN_OPS_DEFAULT_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ADMIN_OPS_MAX_LIMIT,
    default: ADMIN_OPS_DEFAULT_LIMIT,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(ADMIN_OPS_MAX_LIMIT)
  @Type(() => Number)
  limit: number = ADMIN_OPS_DEFAULT_LIMIT;
}
