import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsDateString,
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { SeatBlockStatus } from "@src/schemas/seat-state.schema";

export class BlockSeatsDto {
  @ApiProperty({ description: "ID zone chứa khu vực cần block" })
  @IsMongoId()
  zoneId: string;

  @ApiProperty({ description: "ID khu vực (area) chứa ghế cần block" })
  @IsMongoId()
  areaId: string;

  @ApiProperty({ description: "Danh sách mã ghế cần block", type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  seats: string[];

  @ApiPropertyOptional({
    description:
      "blocked = tạm khóa (có thể mở lại), disabled = không bán vì cấu hình sơ đồ",
    enum: SeatBlockStatus,
    default: SeatBlockStatus.BLOCKED,
  })
  @IsOptional()
  @IsEnum(SeatBlockStatus)
  status?: SeatBlockStatus;

  @ApiPropertyOptional({ description: "Lý do khóa ghế" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;

  @ApiPropertyOptional({
    description:
      "Thời điểm tự động mở khóa. Bỏ trống = khóa vĩnh viễn cho tới khi unblock thủ công.",
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
