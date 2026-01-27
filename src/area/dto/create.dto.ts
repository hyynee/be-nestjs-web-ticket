import { ApiProperty } from "@nestjs/swagger";
import { IsMongoId, IsNumber, IsString } from "class-validator";

export class CreateAreaDTO {
    @ApiProperty({ description: "Sự kiện liên quan" })
    @IsMongoId()
    @IsString()
    eventId: string;
    @ApiProperty({ description: "Khu vực liên quan" })
    @IsMongoId()
    @IsString()
    zoneId: string;
    @ApiProperty({ description: "Tên khu vực" })
    @IsString()
    name: string;
    @ApiProperty({ description: "Mô tả khu vực", required: false })
    @IsString()
    description?: string;
    @ApiProperty({ description: "Nhãn hàng ghế", required: false })
    @IsString()
    rowLabel?: string;
    @ApiProperty({ description: "Số lượng ghế", required: false })
    @IsNumber()
    seatCount?: number;
    @ApiProperty({ description: "Danh sách ghế", required: false })
    seats?: string[];
}