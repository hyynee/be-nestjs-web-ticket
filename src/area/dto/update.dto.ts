import { IsBoolean, IsOptional } from "class-validator";

export class UpdateAreaDTO {
    @IsBoolean()
      @IsOptional()
      isDeleted?: boolean;
}