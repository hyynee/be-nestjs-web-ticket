import { ApiProperty } from "@nestjs/swagger";
import { IsString } from "class-validator";


export class CancleBookingDto {
    @ApiProperty()
    @IsString()
    bookingCode: string;
}