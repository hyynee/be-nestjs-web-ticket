import { ApiProperty } from "@nestjs/swagger";
import { IsEmpty, IsNotEmpty, IsOptional, IsString } from "class-validator";

export class UpdateBookingDto {
  @IsString()
  bookingCode: string;

  @IsOptional()
  @IsString()
  customerName?: string;

  @IsOptional()
  @IsString()
  customerPhone?: string;

  @IsString()
  @IsNotEmpty()
  status: string;


  @IsOptional()
  @IsString()
  notes?: string;
}


