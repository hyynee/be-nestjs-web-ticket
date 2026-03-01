import { ApiProperty } from "@nestjs/swagger";
import { IsMongoId, IsNumber, IsOptional, IsString } from "class-validator";

export class CreateAreaDTO {

    @ApiProperty({ description: "Khu vực liên quan" })
    @IsMongoId()
    @IsString()
    zoneId: string;
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
    @IsNumber()
    seatCount?: number;
    @ApiProperty({ description: "Danh sách ghế", required: false })
    @IsOptional()
    @IsString({ each: true })
    seats?: string[];

}