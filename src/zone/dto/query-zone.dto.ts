// query-zone.dto.ts
import {
  IsMongoId,
  IsString,
  IsBoolean,
  IsOptional,
  IsNumber,
  Min,
  IsPositive,
} from "class-validator";
import { Type } from "class-transformer";
import { Zone } from "@src/schemas/zone.schema";

export interface PaginatedZones {
  data: Zone[];
  total: number;
  page?: number;
  limit?: number;
}
export class QueryZoneDto {
  @IsMongoId()
  @IsOptional()
  eventId?: string;

  @IsString()
  @IsOptional()
  name?: string;

  @IsOptional()
  @IsString()
  search?: string;


  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  isDeleted?: boolean;

  @IsNumber()
  @Min(1)
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsNumber()
  @Min(1)
  @IsPositive()
  @IsOptional()
  @Type(() => Number)
  limit?: number = 10;

  @IsOptional()
  @IsString()
  sortBy?: string = 'createdAt';

  @IsOptional()
  @IsString()
  sortOrder?: 'asc' | 'desc' = 'desc';
}
