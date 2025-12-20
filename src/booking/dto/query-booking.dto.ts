import { IsMongoId, IsNumber, IsOptional, IsString } from "class-validator";
import { Type } from "class-transformer";
export class QueryBookingDto {
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @IsOptional()
  @IsString()
  status?: "pending" | "confirmed" | "cancelled" | "expired";

  @IsOptional()
  @IsString()
  paymentStatus?: "unpaid" | "paid" | "refunded";

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsNumber()
  @Type(() => Number)
  limit?: number = 10;
}