import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";

export enum EndAiccSessionReason {
  COMPLETED = "completed",
  ABANDONED = "abandoned",
  HANDOFF = "handoff",
}

export class EndAiccSessionDto {
  @ApiPropertyOptional({ enum: EndAiccSessionReason })
  @IsOptional()
  @IsEnum(EndAiccSessionReason)
  reason?: EndAiccSessionReason;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  summary?: string;
}
