import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsDate,
  IsEnum,
  IsOptional,
  IsUrl,
  IsArray,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { TimeSlotDto } from "./create-event.dto";

export class UpdateEventDTO {
  @ApiProperty({ description: "Tiêu đề sự kiện", required: false })
  @IsString()
  @IsOptional()
  title?: string;

  @ApiProperty({ description: "Mô tả sự kiện", required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: "Ngày bắt đầu", required: false })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  startDate?: Date;

  @ApiProperty({ description: "Ngày kết thúc", required: false })
  @IsDate()
  @Type(() => Date)
  @IsOptional()
  endDate?: Date;

  @ApiProperty({ description: "Địa điểm tổ chức", required: false })
  @IsString()
  @IsOptional()
  location?: string;

  @ApiProperty({ description: "Link ảnh thumbnail", required: false })
  @IsUrl()
  @IsOptional()
  thumbnail?: string;

  @ApiProperty({
    description: "Trạng thái sự kiện",
    enum: ["draft", "active", "inactive", "ended"],
    required: false,
  })
  @IsEnum(["draft", "active", "inactive", "ended"])
  @IsOptional()
  status?: "draft" | "active" | "inactive" | "ended";

  @ApiPropertyOptional({
    description: "Danh sách khung giờ của sự kiện (ghi đè toàn bộ)",
    type: [TimeSlotDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeSlotDto)
  timeSlots?: TimeSlotDto[];
}
