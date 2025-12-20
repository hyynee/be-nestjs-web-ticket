// ticket.dto.ts
import { IsNotEmpty, IsString, IsOptional, IsMongoId } from "class-validator";

export class CheckInTicketDto {
  @IsNotEmpty()
  @IsString()
  ticketCode: string;

  @IsOptional()
  @IsString()
  checkInLocation?: string; 

  @IsOptional()
  deviceInfo?: string;

  @IsOptional()
  ipAddress?: string;
}

export class QueryTicketDto {
  @IsOptional()
  @IsMongoId()
  eventId?: string;

  @IsOptional()
  @IsString()
  status?: "valid" | "used" | "cancelled" | "expired";

  @IsOptional()
  page?: number = 1;

  @IsOptional()
  limit?: number = 10;
}

export class VerifyTicketDto {
  @IsNotEmpty()
  @IsString()
  ticketCode: string;
}