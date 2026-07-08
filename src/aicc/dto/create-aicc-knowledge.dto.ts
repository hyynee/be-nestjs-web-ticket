import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
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

export class CreateAiccKnowledgeDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @ApiProperty({ enum: AiccKnowledgeCategory })
  @IsEnum(AiccKnowledgeCategory)
  category: AiccKnowledgeCategory;

  @ApiProperty({ maxLength: 12000 })
  @IsString()
  @MinLength(20)
  @MaxLength(12000)
  content: string;

  @ApiPropertyOptional({
    enum: AiccKnowledgeStatus,
    default: AiccKnowledgeStatus.DRAFT,
  })
  @IsOptional()
  @IsEnum(AiccKnowledgeStatus)
  status?: AiccKnowledgeStatus;

  @ApiPropertyOptional({ default: 1, minimum: 1 })
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
