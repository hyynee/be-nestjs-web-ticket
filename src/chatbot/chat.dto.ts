import { ApiProperty } from "@nestjs/swagger";
import { IsString, IsOptional, IsNumber, Min, Max } from "class-validator";

export type ChatContext = Record<string, string | number | boolean | null>;

export interface ChatEventSummary {
  id?: string;
  title?: string;
  description?: string;
  startDate?: Date | string;
  endDate?: Date | string;
  location?: string;
  category?: string;
  thumbnail?: string;
  isActiveNow?: boolean;
  status?: string;
}

export class ChatRequestDto {
  @ApiProperty({ description: "User message to send to the chatbot" })
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  context?: ChatContext;
}

export class EventRecommendationDto {
  @IsOptional()
  @IsString()
  category?: "active" | "upcoming" | "popular";

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  limit?: number = 3;
}

export class ChatResponseDto {
  message: string;
  events: ChatEventSummary[];
  intent: string;
  sessionId: string;
  timestamp: Date;
}
