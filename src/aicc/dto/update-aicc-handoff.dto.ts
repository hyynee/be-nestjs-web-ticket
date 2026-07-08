import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEnum,
  IsMongoId,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { AiccHandoffStatus } from "../schemas/aicc-handoff.schema";

export class UpdateAiccHandoffDto {
  @ApiPropertyOptional({ enum: AiccHandoffStatus })
  @IsOptional()
  @IsEnum(AiccHandoffStatus)
  status?: AiccHandoffStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsMongoId()
  assignedTo?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolutionNote?: string;
}
