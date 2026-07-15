import { ApiProperty } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsMongoId,
  IsString,
} from "class-validator";

export class UnblockSeatsDto {
  @ApiProperty({ description: "ID zone chứa khu vực cần unblock" })
  @IsMongoId()
  zoneId: string;

  @ApiProperty({ description: "ID khu vực (area) chứa ghế cần unblock" })
  @IsMongoId()
  areaId: string;

  @ApiProperty({ description: "Danh sách mã ghế cần unblock", type: [String] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  seats: string[];
}
