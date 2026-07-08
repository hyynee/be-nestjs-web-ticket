import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  AiccKnowledgeCategory,
  AiccKnowledgeStatus,
} from "../schemas/aicc-knowledge.schema";

export class QueryAiccKnowledgeDto {
  @ApiPropertyOptional({ enum: AiccKnowledgeCategory })
  @IsOptional()
  @IsEnum(AiccKnowledgeCategory)
  category?: AiccKnowledgeCategory;

  @ApiPropertyOptional({ enum: AiccKnowledgeStatus })
  @IsOptional()
  @IsEnum(AiccKnowledgeStatus)
  status?: AiccKnowledgeStatus;

  @ApiPropertyOptional({ maxLength: 160 })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  search?: string;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class SearchAiccKnowledgeDto {
  @ApiProperty({ maxLength: 160 })
  @IsString()
  @MinLength(2)
  @MaxLength(160)
  query: string;

  @ApiPropertyOptional({ enum: AiccKnowledgeCategory })
  @IsOptional()
  @IsEnum(AiccKnowledgeCategory)
  category?: AiccKnowledgeCategory;

  @ApiPropertyOptional({ default: 5, minimum: 1, maximum: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10)
  topK?: number = 5;
}
