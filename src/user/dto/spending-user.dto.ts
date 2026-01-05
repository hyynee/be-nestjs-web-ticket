import { IsOptional, IsInt, Min, Max } from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty } from "@nestjs/swagger";

export class UserSpendingQueryDto {
    @ApiProperty({ required: false, description: "Day for filtering spending (1-31)" })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(31)
    day?: number;

    @ApiProperty({ required: false, description: "Month for filtering spending (1-12)" })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(12)
    month?: number;

    @ApiProperty({ required: false, description: "Year for filtering spending (e.g., 2023)" })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(2000)
    year?: number;
}
