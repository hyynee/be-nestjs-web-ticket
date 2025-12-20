// create-zone.dto.ts
import {
  IsMongoId,
  IsString,
  IsNumber,
  IsPositive,
  Min,
  IsOptional,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class CreateZoneDto {
  @ApiProperty({ description: "sự kiện liên quan" })
  @IsMongoId()
  @IsString()
  eventId: string;

  @ApiProperty({ description: "tên khu vực" })
  @IsString()
  name: string;

  @ApiProperty({ description: "giá vé khu vực" })
  @IsNumber()
  @IsPositive()
  @Type(() => Number)
  price: number;

  @ApiProperty({ description: "sức chứa khu vực", required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  capacity?: number;

  @ApiProperty({ description: "số vé đã bán", required: false })
  @IsNumber()
  @Min(0)
  @IsOptional()
  @Type(() => Number)
  soldCount?: number;

  @ApiProperty({ description: "Zone có ghế ngồi hay không", required: false })
  @IsOptional()
  hasSeating?: boolean;

  @ApiProperty({ description: "Thời gian bắt đầu bán", required: false })
  @IsOptional()
  saleStartDate?: Date;

  @ApiProperty({ description: "Thời gian kết thúc bán", required: false })
  @IsOptional()
  saleEndDate?: Date;
}
