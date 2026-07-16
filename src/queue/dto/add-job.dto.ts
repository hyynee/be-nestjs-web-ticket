import { IsEnum, IsObject } from "class-validator";
import { ApiProperty } from "@nestjs/swagger";
import { QueueJobType } from "./queue-job-type.enum";
import { IsValidJobPayload } from "./is-valid-job-payload.validator";
import { QueueJobPayload } from "./job-payloads.dto";

export { QueueJobType } from "./queue-job-type.enum";

export class AdminAddJobDto {
  @ApiProperty({ enum: QueueJobType })
  @IsEnum(QueueJobType)
  type: QueueJobType;

  @ApiProperty({
    type: Object,
    description: "Job payload — shape depends on job type",
  })
  @IsObject()
  @IsValidJobPayload()
  payload: QueueJobPayload;
}
