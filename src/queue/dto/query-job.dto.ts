import { Type } from "class-transformer";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  DEAD_LETTER_QUEUE_NAME,
  DEFAULT_QUEUE_NAME,
  EVENT_CANCELLATION_QUEUE_NAME,
} from "../queue.constants";

export const QUEUE_JOB_STATUSES = [
  "active",
  "waiting",
  "failed",
  "delayed",
  "completed",
] as const;

export const QUEUE_NAMES = [
  DEFAULT_QUEUE_NAME,
  DEAD_LETTER_QUEUE_NAME,
  EVENT_CANCELLATION_QUEUE_NAME,
] as const;

export class QueryJobDto {
  @ApiPropertyOptional({ enum: QUEUE_JOB_STATUSES })
  @IsOptional()
  @IsString()
  @IsIn(QUEUE_JOB_STATUSES)
  status?: (typeof QUEUE_JOB_STATUSES)[number];

  @ApiPropertyOptional({ enum: QUEUE_NAMES, default: "default" })
  @IsOptional()
  @IsString()
  @IsIn(QUEUE_NAMES)
  queue?: (typeof QUEUE_NAMES)[number] = "default";

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 20;
}
