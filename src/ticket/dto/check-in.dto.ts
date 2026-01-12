import { ApiProperty } from "@nestjs/swagger";



export class CheckInDTO {
    @ApiProperty()
    ticketCode: string;
    @ApiProperty()
    location: string;
    @ApiProperty()
    deviceInfo: string;
    @ApiProperty()
    ipAddress: string;
    @ApiProperty()
    adminId: string;
}