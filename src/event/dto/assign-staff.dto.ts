import { IsMongoId, IsOptional, IsString, MaxLength } from "class-validator";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class AssignStaffDto {
  @ApiProperty({
    description: "User ID to assign as check-in staff for this event",
  })
  @IsMongoId()
  userId: string;

  @ApiPropertyOptional({
    description: "Operational note, e.g. which gate/device",
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}
