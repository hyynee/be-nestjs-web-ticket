import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsNotEmpty,
  IsDate,
  IsEnum,
  IsOptional,
  IsUrl,
  MaxLength,
  IsArray,
  ValidateNested,
  IsMongoId,
  IsInt,
  Min,
} from "class-validator";
import { Type } from "class-transformer";

export class TimeSlotDto {
  @ApiPropertyOptional({
    description: "ID slot MongoDB (chỉ cung cấp khi cập nhật slot đã tồn tại)",
  })
  @IsOptional()
  @IsMongoId()
  _id?: string;

  @ApiProperty({ description: "Nhãn khung giờ (VD: Ca sáng, Ca chiều)" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  label: string;

  @ApiProperty({
    description: "Thời điểm bắt đầu slot",
    example: "2025-10-15T09:00:00.000Z",
  })
  @IsDate()
  @Type(() => Date)
  @IsNotEmpty()
  startTime: Date;

  @ApiProperty({
    description: "Thời điểm kết thúc slot",
    example: "2025-10-15T12:00:00.000Z",
  })
  @IsDate()
  @Type(() => Date)
  @IsNotEmpty()
  endTime: Date;

  @ApiPropertyOptional({
    description:
      "Số vé tối đa cho khung giờ này. Bỏ trống = không giới hạn (theo zone).",
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  capacity?: number;
}

export class CreateEventDTO {
  @ApiProperty({ description: "Tiêu đề sự kiện" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title: string;

  @ApiProperty({ description: "Mô tả sự kiện", required: false })
  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({
    description: "Ngày bắt đầu",
    example: "2025-10-15T09:00:00.000Z",
  })
  @IsDate()
  @Type(() => Date)
  @IsNotEmpty()
  startDate: Date;

  @ApiProperty({
    description: "Ngày kết thúc",
    example: "2025-10-15T18:00:00.000Z",
  })
  @IsDate()
  @Type(() => Date)
  @IsNotEmpty()
  endDate: Date;

  @ApiProperty({ description: "Địa điểm tổ chức" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  location: string;

  @ApiProperty({ description: "Link ảnh thumbnail", required: false })
  @IsUrl()
  @IsOptional()
  thumbnail?: string;

  @ApiProperty({
    description: "Trạng thái sự kiện",
    enum: ["draft", "active", "inactive", "ended"],
    default: "draft",
  })
  @IsEnum(["draft", "active", "inactive", "ended"])
  @IsOptional()
  status?: "draft" | "active" | "inactive" | "ended";

  @ApiPropertyOptional({
    description: "Danh sách khung giờ của sự kiện",
    type: [TimeSlotDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TimeSlotDto)
  timeSlots?: TimeSlotDto[];
}
