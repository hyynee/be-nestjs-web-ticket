import { IsBoolean, IsOptional, IsString } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class SoftDeleteAreaDTO {
  @IsBoolean()
  @IsOptional()
  isDeleted: boolean;
}

export class UpdateAreaDTO {
  
  @ApiProperty({ description: "ID khu vực", required: false })
   @IsOptional()
  @IsString()
  zoneId?: string;
  @ApiProperty({ description: "Tên khu vực" })
  @IsString()
  name: string;
  @ApiProperty({ description: "Mô tả khu vực", required: false })
  @IsString()
  @IsOptional()
  description?: string;
  @ApiProperty({ description: "Nhãn hàng ghế", required: false })
  @IsString()
  @IsOptional()
  rowLabel?: string;
  @ApiProperty({ description: "Số lượng ghế", required: false })
  @IsOptional()
  seatCount?: number;
  @ApiProperty({ description: "Danh sách ghế", required: false })
  @IsOptional()
  seats?: string[];
}