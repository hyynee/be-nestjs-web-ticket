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
import { RefundProvider } from "@src/schemas/refund-request.schema";
import {
  REPORT_DEFAULT_LIMIT,
  REPORT_DEFAULT_PAGE,
  REPORT_MAX_LIMIT,
} from "@src/report/report.constants";

const REPORT_GROUP_BY_VALUES = ["day", "week", "month"] as const;

abstract class BaseReportQueryDto {
  @ApiPropertyOptional({ description: "ISO date — inclusive lower bound" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: "ISO date — inclusive upper bound" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ minimum: 1, default: REPORT_DEFAULT_PAGE })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page: number = REPORT_DEFAULT_PAGE;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: REPORT_MAX_LIMIT,
    default: REPORT_DEFAULT_LIMIT,
  })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(REPORT_MAX_LIMIT)
  @Type(() => Number)
  limit: number = REPORT_DEFAULT_LIMIT;
}

export class SalesReportQueryDto extends BaseReportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  zoneId?: string;

  @ApiPropertyOptional({ enum: REPORT_GROUP_BY_VALUES, default: "day" })
  @IsOptional()
  @IsIn(REPORT_GROUP_BY_VALUES)
  groupBy: (typeof REPORT_GROUP_BY_VALUES)[number] = "day";
}

export class CheckInReportQueryDto extends BaseReportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  zoneId?: string;
}

export class RefundReportQueryDto extends BaseReportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @ApiPropertyOptional({ enum: RefundProvider })
  @IsOptional()
  @IsEnum(RefundProvider)
  provider?: RefundProvider;
}

export class PaymentReconciliationQueryDto extends BaseReportQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  eventId?: string;
}

export class OrganizerReportQueryDto extends BaseReportQueryDto {}
