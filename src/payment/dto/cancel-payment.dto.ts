import { IsNotEmpty, IsString, Matches, MaxLength } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class CancelPaymentDto {
  @ApiProperty({ description: "Booking code to cancel payment for" })
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  @Matches(/^[A-Z0-9_-]+$/, {
    message:
      "bookingCode must contain only uppercase letters, digits, hyphens or underscores",
  })
  bookingCode: string;
}
