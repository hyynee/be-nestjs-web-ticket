import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { QueryWebhookEventDto } from "./dto/query-webhook-event.dto";
import { PaymentOpsService } from "./payment-ops.service";
import type {
  PaymentWebhookEventDetail,
  PaymentWebhookEventListResult,
  PaymentWebhookRetryResult,
} from "./types/payment-ops.types";

@ApiCookieAuth("access_token")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
@Controller("payment-ops")
export class PaymentOpsController {
  constructor(private readonly paymentOpsService: PaymentOpsService) {}

  @Get("webhook-events")
  async listWebhookEvents(
    @Query() query: QueryWebhookEventDto
  ): Promise<PaymentWebhookEventListResult> {
    return this.paymentOpsService.findAll(query);
  }

  @Get("webhook-events/:id")
  async getWebhookEvent(
    @Param("id") id: string
  ): Promise<PaymentWebhookEventDetail> {
    return this.paymentOpsService.findById(id);
  }

  @Post("webhook-events/:id/retry")
  @HttpCode(200)
  async retryWebhookEvent(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload
  ): Promise<PaymentWebhookRetryResult> {
    return this.paymentOpsService.retryWebhookEvent(id, user);
  }
}
