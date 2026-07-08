import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { AiccChannel } from "../schemas/aicc-session.schema";

export class CreateAiccSessionDto {
  @ApiPropertyOptional({ enum: AiccChannel, default: AiccChannel.CHAT })
  @IsOptional()
  @IsEnum(AiccChannel)
  channel?: AiccChannel;

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
