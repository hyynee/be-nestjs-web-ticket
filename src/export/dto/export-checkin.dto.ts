import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsMongoId } from 'class-validator';

export class ExportCheckInDto {
    @IsMongoId()
    @ApiProperty({ description: 'Event ID to export check-in zones for' })
    eventId: string;
    @ApiProperty({ description: 'Export format', enum: ['csv', 'excel'] })
    @IsIn(['csv', 'excel'])
    @ApiProperty({ enum: ['csv', 'excel'] })
    format: 'csv' | 'excel';
}
