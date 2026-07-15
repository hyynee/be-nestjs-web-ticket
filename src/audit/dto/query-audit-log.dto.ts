import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsMongoId,
  IsNumber,
  IsOptional,
  Max,
  Min,
} from "class-validator";
import { ApiPropertyOptional } from "@nestjs/swagger";
import { AuditAction } from "@src/schemas/audit-log.schema";

export const AUDIT_SORT_FIELDS = ["createdAt"] as const;

export class QueryAuditLogDto {
  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  actorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  bookingId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  ticketId?: string;

  @ApiPropertyOptional({ description: "ISO date — inclusive lower bound" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: "ISO date — inclusive upper bound" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: AUDIT_SORT_FIELDS, default: "createdAt" })
  @IsOptional()
  @IsIn(AUDIT_SORT_FIELDS)
  sortBy?: (typeof AUDIT_SORT_FIELDS)[number] = "createdAt";

  @ApiPropertyOptional({ enum: ["asc", "desc"], default: "desc" })
  @IsOptional()
  @IsIn(["asc", "desc"])
  sortOrder?: "asc" | "desc" = "desc";

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
