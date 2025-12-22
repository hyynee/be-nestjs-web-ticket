import { ApiProperty } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, IsInt, Min, IsBoolean } from "class-validator";
import { Transform, Type } from "class-transformer";
export class QueryUserDTO {
    @ApiProperty({ description: "Tìm kiếm theo tiêu đề", required: false })
    @IsString()
    @IsOptional()
    search?: string;

    @ApiProperty({ description: "lọc theo trạng thái hoạt động", required: false })
    @IsBoolean()
    @Transform(({ value }) => {
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    })
    isActive?: boolean;

    @ApiProperty({
        description: "Lọc theo vai trò",
        enum: ["user", "admin"],
        required: false,
    })
    @IsEnum(["user", "admin"])
    @IsOptional()
    role?: string;

    @ApiProperty({ description: "Số trang", required: false, default: 1 })
    @IsInt()
    @Min(1)
    @Type(() => Number)
    @IsOptional()
    page?: number = 1;

    @ApiProperty({
        description: "Số lượng item trên 1 trang",
        required: false,
        default: 10,
    })
    @IsInt()
    @Min(1)
    @Type(() => Number)
    @IsOptional()
    limit?: number = 10;
}