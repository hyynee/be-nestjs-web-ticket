import {
  IsNotEmpty,
  IsString,
  IsNumber,
  IsArray,
  ArrayMaxSize,
  IsEmail,
  IsOptional,
  Min,
  Max,
  IsMongoId,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class CreateBookingDto {
  @ApiProperty({ description: "ID của sự kiện" })
  @IsNotEmpty()
  @IsMongoId()
  eventId: string;

  @ApiProperty({ description: "ID khu vực (zone) đặt vé" })
  @IsNotEmpty()
  @IsMongoId()
  zoneId: string;

  @ApiPropertyOptional({
    description: "ID khu vực con (area) – nếu zone có seating",
  })
  @IsOptional()
  @IsMongoId()
  areaId?: string;

  @ApiPropertyOptional({
    description: "Danh sách ghế (chỉ khi zone có seating và area đã chọn)",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  seats?: string[];

  @ApiProperty({ description: "Số lượng vé" })
  @IsNotEmpty()
  @IsNumber()
  @Min(1)
  @Max(10)
  @Type(() => Number)
  quantity: number;

  @ApiProperty({ description: "Email khách hàng" })
  @IsNotEmpty()
  @IsEmail()
  customerEmail: string;

  @ApiPropertyOptional({ description: "Tên khách hàng" })
  @IsOptional()
  @IsString()
  customerName?: string;

  @ApiPropertyOptional({ description: "Số điện thoại khách hàng" })
  @IsOptional()
  @IsString()
  customerPhone?: string;

  @ApiPropertyOptional({ description: "Ghi chú thêm" })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({
    description: "ID khung giờ (bắt buộc nếu sự kiện có định nghĩa time slots)",
  })
  @IsOptional()
  @IsMongoId()
  timeSlotId?: string;
}
