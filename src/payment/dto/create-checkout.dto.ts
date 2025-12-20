import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateCheckoutSessionDto {
  @ApiProperty({ example: 'BK20251216223400553' })
  @IsNotEmpty()
  @IsString()
  bookingCode: string; 
}