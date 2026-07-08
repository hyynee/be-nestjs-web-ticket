import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsEnum, IsOptional } from "class-validator";
import { AiccChannel } from "../schemas/aicc-session.schema";

export class QueryAiccAnalyticsDto {
  @ApiPropertyOptional({ example: "2026-07-01" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: "2026-07-07" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: [...Object.values(AiccChannel), "all"] })
  @IsOptional()
  @IsEnum({ ...AiccChannel, ALL: "all" })
  channel?: AiccChannel | "all" = "all";
}
