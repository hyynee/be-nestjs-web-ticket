import {
  IsMongoId,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import { Type } from "class-transformer";
export class QueryBookingDto {
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsString()
  status?: "pending" | "confirmed" | "cancelled" | "expired";

  @IsOptional()
  @IsString()
  paymentStatus?: "unpaid" | "paid" | "refund_pending" | "refunded";

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  sortBy?: string = "createdAt";

  @IsOptional()
  @IsString()
  sortOrder?: "asc" | "desc" = "desc";
}
