import {
  IsMongoId,
  IsOptional,
  IsString,
  IsInt,
  Min,
  IsEnum,
} from "class-validator";
import { Type } from "class-transformer";

export enum TicketStatus {
  VALID = "valid",
  USED = "used",
  CANCELLED = "cancelled",
  EXPIRED = "expired",
}

export class QueryTicketDto {
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @IsOptional()
  @IsMongoId()
  zoneId?: string;

  @IsOptional()
  @IsMongoId()
  areaId?: string;

  @IsOptional()
  @IsMongoId()
  userId?: string;

  @IsOptional()
  @IsString()
  ticketCode?: string;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit: number = 10;

  @IsOptional()
  sortBy: "createdAt" | "price" | "status" = "createdAt";

  @IsOptional()
  sortOrder: "asc" | "desc" = "desc";
}
