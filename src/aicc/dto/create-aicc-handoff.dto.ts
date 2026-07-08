import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import {
  AiccHandoffPriority,
  AiccHandoffReason,
} from "../schemas/aicc-handoff.schema";

export class CreateAiccHandoffDto {
  @ApiProperty({ example: "aicc_..." })
  @IsString()
  @MinLength(8)
  @MaxLength(80)
  sessionId: string;

  @ApiProperty({ enum: AiccHandoffReason })
  @IsEnum(AiccHandoffReason)
  reason: AiccHandoffReason;

  @ApiPropertyOptional({
    enum: AiccHandoffPriority,
    default: AiccHandoffPriority.NORMAL,
  })
  @IsOptional()
  @IsEnum(AiccHandoffPriority)
  priority?: AiccHandoffPriority;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(20)
  @MaxLength(4000)
  summary: string;

  @ApiPropertyOptional({ example: "customer@example.com" })
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  customerEmail?: string;

  @ApiPropertyOptional({ example: "+84901234567" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerPhone?: string;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
