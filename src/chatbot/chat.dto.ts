import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, Min, Max } from 'class-validator';

export class ChatRequestDto {
    @ApiProperty({ description: 'User message to send to the chatbot' })
  @IsString()
  message: string;

  @IsOptional()
  @IsString()
  sessionId?: string;

  @IsOptional()
  context?: any;
}

export class EventRecommendationDto {
  @IsOptional()
  @IsString()
  category?: 'active' | 'upcoming' | 'popular';

  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10)
  limit?: number = 3;
}

export class ChatResponseDto {
  success: boolean;
  data: {
    message: string;
    events: any[];
    intent: string;
    sessionId: string;
    timestamp: Date;
  };
  error?: string;
}