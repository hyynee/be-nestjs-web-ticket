import { ApiProperty } from "@nestjs/swagger";
import { IsEmail } from "class-validator";

export class ForgotPassword {
    @ApiProperty()
    @IsEmail()
    email: string
}