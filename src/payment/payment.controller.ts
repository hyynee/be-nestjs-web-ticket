import {
  Body,
  Controller,
  Headers,
  HttpCode,
  Req,
  Res,
  Get,
  Param,
  Query,
  Logger,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { PaymentService } from "./payment.service";
import { AuthGuard } from "@nestjs/passport";
import { UseGuards, Post } from "@nestjs/common";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ApiCookieAuth } from "@nestjs/swagger";
import { CreateCheckoutSessionDto } from "./dto/create-checkout.dto";
import { QueryPaymentHistoryDto } from "./dto/query-payment-history.dto";
import Stripe from "stripe";
import type { Request, Response } from "express";

type StripeWebhookRequest = Request & {
  rawBody?: Buffer;
};

const normalizeRawBody = (req: StripeWebhookRequest): Buffer => {
  if (req.rawBody && Buffer.isBuffer(req.rawBody)) {
    return req.rawBody;
  }

  if (Buffer.isBuffer(req.body)) {
    return req.body;
  }

  return Buffer.from(JSON.stringify(req.body ?? {}));
};

@Controller("payment")
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(private readonly paymentService: PaymentService) {}

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(201)
  @Post("create-checkout-session")
  async createCheckoutSession(
    @CurrentUser() user: JwtPayload,
    @Body() createPayment: CreateCheckoutSessionDto
  ) {
    const userId = user.userId;
    return this.paymentService.createCheckoutSession(
      userId,
      createPayment.bookingCode
    );
  }

  @Post("webhook")
  @HttpCode(200)
  async handleWebhook(
    @Headers("stripe-signature") signature: string,
    @Req() req: StripeWebhookRequest,
    @Res() res: Response
  ) {
    let event: Stripe.Event;
    try {
      const rawBody = normalizeRawBody(req);
      event = this.paymentService.verifyWebhook(rawBody, signature);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown webhook error";
      return res.status(400).send(`Webhook Error: ${message}`);
    }

    let isFirstProcessing: boolean;
    try {
      isFirstProcessing = await this.paymentService.acquireWebhookIdempotency(
        event.id
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.logger.error(
        `Stripe webhook handler failed for event ${event.type}: ${message}`
      );
      return res
        .status(503)
        .send("Temporary payment processing issue. Please retry webhook.");
    }

    if (!isFirstProcessing) {
      return res.status(200).json({ received: true, deduplicated: true });
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          this.paymentService.handlePaymentIntentSucceeded(event.data.object);
          break;
        case "checkout.session.completed":
          await this.paymentService.handleCheckoutSessionCompleted(
            event.data.object
          );
          break;
        default:
          this.logger.warn(
            `Unhandled Stripe webhook event type: ${event.type}`
          );
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      this.logger.error(
        `Webhook handler error for event ${event.id}: ${err instanceof Error ? err.message : "unknown error"}`
      );
      return res
        .status(500)
        .send(
          `Handler Error: ${err instanceof Error ? err.message : "Unknown error"}`
        );
    }
  }

  // check out paypal
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Post("create-paypal-transaction")
  async createPaypalTransaction(
    @CurrentUser() user: JwtPayload,
    @Body() createPayment: CreateCheckoutSessionDto
  ) {
    const userId = user.userId;
    return this.paymentService.createPaypalTransaction(
      userId,
      createPayment.bookingCode
    );
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Post("/:id/finalize")
  async finalizePaypalTransaction(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload
  ) {
    return this.paymentService.finalizePaypalTransaction(id, user.userId);
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Get("history")
  async getPaymentHistory(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryPaymentHistoryDto
  ) {
    const userId = user.userId;
    return this.paymentService.getPaymentHistory(userId, query);
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Post("cancel")
  async cancelPayment(
    @Body() dto: { bookingCode: string },
    @CurrentUser() user: JwtPayload
  ) {
    return this.paymentService.handlePaymentCancelled(
      user.userId,
      dto.bookingCode
    );
  }
}
