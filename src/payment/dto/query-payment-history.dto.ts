import { Type } from "class-transformer";
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";

export const PAYMENT_HISTORY_STATUSES = [
  "pending",
  "processing",
  "succeeded",
  "failed",
  "canceled",
  "refunded",
] as const;

export const PAYMENT_HISTORY_SORT_FIELDS = [
  "createdAt",
  "paidAt",
  "updatedAt",
] as const;

export class QueryPaymentHistoryDto {
  @IsOptional()
  @IsString()
  @IsIn(PAYMENT_HISTORY_STATUSES)
  status?: (typeof PAYMENT_HISTORY_STATUSES)[number];

  @IsOptional()
  @IsString()
  @IsIn(PAYMENT_HISTORY_SORT_FIELDS)
  sortBy?: (typeof PAYMENT_HISTORY_SORT_FIELDS)[number] = "createdAt";

  @IsOptional()
  @IsString()
  @IsIn(["asc", "desc"])
  sortOrder?: "asc" | "desc" = "desc";

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsNumber()
  @Min(1)
  @Max(100)
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;
}
