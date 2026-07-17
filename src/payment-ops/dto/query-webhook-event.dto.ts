import { Transform } from "class-transformer";
import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from "class-validator";
import {
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";

export class QueryWebhookEventDto {
  @ApiPropertyOptional({ enum: PaymentWebhookProvider })
  @IsOptional()
  @IsEnum(PaymentWebhookProvider)
  provider?: PaymentWebhookProvider;

  @ApiPropertyOptional({ enum: PaymentWebhookEventStatus })
  @IsOptional()
  @IsEnum(PaymentWebhookEventStatus)
  status?: PaymentWebhookEventStatus;

  @ApiPropertyOptional({ example: "checkout.session.completed" })
  @IsOptional()
  @IsString()
  eventType?: string;

  @ApiPropertyOptional({ description: "ISO date lower bound" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: "ISO date upper bound" })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  page = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
