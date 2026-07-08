import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";
import { AiccMessageSpeaker } from "../schemas/aicc-message.schema";

export class CreateAiccTranscriptDto {
  @ApiPropertyOptional({
    description: "External turn number from the voice gateway.",
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  turnNo?: number;

  @ApiProperty({
    enum: AiccMessageSpeaker,
    default: AiccMessageSpeaker.CUSTOMER,
  })
  @IsEnum(AiccMessageSpeaker)
  speaker: AiccMessageSpeaker = AiccMessageSpeaker.CUSTOMER;

  @ApiProperty({ maxLength: 4000 })
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  text: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 1 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  confidence?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  startedMs?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  endedMs?: number;

  @ApiPropertyOptional({ minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  sttLatencyMs?: number;

  @ApiPropertyOptional({ type: Object })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
