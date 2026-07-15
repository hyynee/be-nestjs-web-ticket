import { IsMongoId } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

export class AssignOrganizerDto {
  @ApiProperty({ description: "User ID to assign as organizer for this event" })
  @IsMongoId()
  userId: string;
}
