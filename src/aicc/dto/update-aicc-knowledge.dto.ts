import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import {
  AiccKnowledgeCategory,
  AiccKnowledgeStatus,
} from "../schemas/aicc-knowledge.schema";

export class UpdateAiccKnowledgeDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ enum: AiccKnowledgeCategory })
  @IsOptional()
  @IsEnum(AiccKnowledgeCategory)
  category?: AiccKnowledgeCategory;

  @ApiPropertyOptional({ maxLength: 12000 })
  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(12000)
  content?: string;

  @ApiPropertyOptional({ enum: AiccKnowledgeStatus })
  @IsOptional()
  @IsEnum(AiccKnowledgeStatus)
  status?: AiccKnowledgeStatus;

  @ApiPropertyOptional({ minimum: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
