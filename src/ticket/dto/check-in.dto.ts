import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsNotEmpty, IsOptional, IsString, MaxLength } from "class-validator";

export class CheckInDTO {
  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  ticketCode: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  location?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(256)
  deviceInfo?: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  @MaxLength(64)
  ipAddress: string;

  @ApiProperty()
  @IsNotEmpty()
  @IsString()
  adminId: string;
}
