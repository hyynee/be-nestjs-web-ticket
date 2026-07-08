import {
  IsMongoId,
  IsOptional,
  IsString,
  IsInt,
  Min,
  IsEnum,
} from "class-validator";
import { Type } from "class-transformer";
import { TicketStatus } from "./query.dto";

export class MyTicketsQueryDto {
  @IsOptional()
  @IsMongoId()
  bookingId?: string;

  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @IsOptional()
  @IsEnum(TicketStatus)
  status?: TicketStatus;

  @IsOptional()
  @IsString()
  ticketCode?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit: number = 20;

  @IsOptional()
  sortBy: "createdAt" | "price" | "status" = "createdAt";

  @IsOptional()
  sortOrder: "asc" | "desc" = "desc";
}
