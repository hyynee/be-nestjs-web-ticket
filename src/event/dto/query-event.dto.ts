import { IsBoolean, IsOptional } from "class-validator";
import { Transform, Type } from "class-transformer";
export class QueryEventDTO {
 
  @IsOptional()
  @IsBoolean()
  // @Transform(({ value }) => value === 'true')
  isDeleted: boolean;


  @Type(() => Number)
  page?: number = 1;

  @Type(() => Number)
  limit?: number = 10;
}
