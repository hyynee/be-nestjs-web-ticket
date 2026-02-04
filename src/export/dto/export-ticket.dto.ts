import { IsEnum, IsMongoId, IsOptional, IsDateString } from 'class-validator';
import { ExportBaseDto } from './export-base.dto';
import { ApiProperty } from '@nestjs/swagger';

export class ExportTicketDto extends ExportBaseDto {
    @IsMongoId()
    @ApiProperty({ description: 'Event ID to export tickets for' })
    eventId: string;

    @IsOptional()
    @IsMongoId()
    @ApiProperty({ description: 'Zone ID to export tickets for', required: false })
    zoneId?: string;

    @IsOptional()
    @IsEnum(['valid', 'used', 'cancelled', 'expired'])
    status?: 'valid' | 'used' | 'cancelled' | 'expired';

    @IsOptional()
    @IsDateString()
    startDate?: string;

    @IsOptional()
    @IsDateString()
    endDate?: string;
}
