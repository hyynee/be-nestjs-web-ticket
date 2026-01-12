import { IsOptional, IsString, IsDateString } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class DashboardQueryDto {
  @ApiPropertyOptional({ description: 'Event ID to filter statistics' })
  @IsOptional()
  @IsString()
  eventId?: string;

  @ApiPropertyOptional({ description: 'Start date (ISO format)' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'End date (ISO format)' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}


export class RevenueStatisticsQueryDto {
    @ApiPropertyOptional({ description: 'Start date (ISO format)' })
  @IsOptional()
  @IsDateString()
  from: string;    
  @ApiPropertyOptional({ description: 'End date (ISO format)' })
  @IsOptional()
  @IsDateString()   
  to: string;
  @ApiPropertyOptional({ description: 'Event ID to filter statistics' })
  @IsOptional()
  @IsString()
  eventId?: string;
  @ApiPropertyOptional({ description: 'Group by day or month' })
  @IsOptional()
  @IsString()
  groupBy?: 'day' | 'month';
}

export class RevenueStatisticsByEventQueryDto {
    @ApiPropertyOptional({ description: 'Event ID to filter statistics' })
  @IsOptional()
  @IsString()
  eventId?: string;
}