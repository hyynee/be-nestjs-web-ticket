import { IsOptional, IsString, IsBoolean, IsMongoId, IsInt, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { Area } from "@src/schemas/area.schema";

export interface PaginatedArea {
  data: Area[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export class QueryAreaDto {
 
  @IsOptional()
  @IsMongoId({ message: 'zoneId phải là ObjectId hợp lệ' })
  zoneId?: string;

  @IsOptional()
  @IsString()
  name?: string; 

  @IsOptional()
  @IsString()
  search?: string; 

  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  isDeleted?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt'; 

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}