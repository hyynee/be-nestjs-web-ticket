import { ApiProperty } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsNotEmpty, IsString } from "class-validator";

export class CreateCheckoutSessionDto {
  @ApiProperty({ example: "BK20251216223400553" })
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value
  )
  @IsNotEmpty()
  @IsString()
  bookingCode: string;
}
