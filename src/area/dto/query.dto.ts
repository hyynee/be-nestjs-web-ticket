import {
  IsOptional,
  IsString,
  IsBoolean,
  IsMongoId,
  IsIn,
  IsInt,
  Min,
  Max,
  MaxLength,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { Area } from "@src/schemas/area.schema";
import { ALLOWED_AREA_SORT_FIELDS, AreaSortField } from "../area.constants";

export interface PaginatedArea {
  data: Area[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class QueryAreaDto {
  @IsOptional()
  @IsMongoId({ message: "zoneId phải là ObjectId hợp lệ" })
  zoneId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;

  @IsOptional()
  @Transform(({ value }) => {
    if (value === "true") return true;
    if (value === "false") return false;
    return value;
  })
  @IsBoolean()
  hasSeating?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @IsIn(ALLOWED_AREA_SORT_FIELDS)
  sortBy?: AreaSortField = "createdAt";

  @IsOptional()
  @IsIn(["asc", "desc"])
  sortOrder?: "asc" | "desc" = "desc";
}
