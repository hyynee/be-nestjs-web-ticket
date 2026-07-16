import {
  BadRequestException,
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
import { PaymentService, WebhookIdempotencyStatus } from "./payment.service";
import { AuthGuard } from "@nestjs/passport";
import { UseGuards, Post } from "@nestjs/common";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ApiCookieAuth } from "@nestjs/swagger";
import { CreateCheckoutSessionDto } from "./dto/create-checkout.dto";
import { QueryPaymentHistoryDto } from "./dto/query-payment-history.dto";
import { CancelPaymentDto } from "./dto/cancel-payment.dto";
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
  @UseGuards(AuthGuard("jwt"), VerifiedUserGuard)
  @HttpCode(201)
  @Post("create-checkout-session")
  async createCheckoutSession(
    @CurrentUser() user: JwtPayload,
    @Body() createPayment: CreateCheckoutSessionDto
  ): ReturnType<PaymentService["createCheckoutSession"]> {
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
  ): Promise<Response> {
    let event: Stripe.Event;
    try {
      const rawBody = normalizeRawBody(req);
      event = this.paymentService.verifyWebhook(rawBody, signature);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Unknown webhook error";
      return res.status(400).send(`Webhook Error: ${message}`);
    }

    let idempotencyStatus: WebhookIdempotencyStatus;
    try {
      idempotencyStatus = await this.paymentService.acquireWebhookIdempotency(
        event.id
      );
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "unknown error";
      this.logger.warn(
        `Redis unavailable for webhook ${event.id} (${event.type}): ${message} — attempting DB fallback`
      );
      try {
        idempotencyStatus =
          await this.paymentService.checkWebhookIdempotencyFromDB(event);
      } catch (dbErr: unknown) {
        const dbMsg = dbErr instanceof Error ? dbErr.message : "unknown";
        this.logger.error(
          `DB fallback also failed for webhook ${event.id}: ${dbMsg} — returning 503`
        );
        return res
          .status(503)
          .send("Service temporarily unavailable. Stripe will retry.");
      }
    }

    if (idempotencyStatus === "succeeded") {
      return res.status(200).json({ received: true, deduplicated: true });
    }

    if (idempotencyStatus === "processing") {
      this.logger.warn(
        `Stripe event ${event.id} is already being processed by another instance`
      );
      return res
        .status(503)
        .json({ message: "Event is currently being processed, retry later" });
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await this.paymentService.handlePaymentIntentSucceeded(
            event.data.object
          );
          break;
        case "checkout.session.completed":
          await this.paymentService.handleCheckoutSessionCompleted(
            event.data.object
          );
          break;
        case "charge.refunded":
          await this.paymentService.handleChargeRefunded(event.data.object);
          break;
        case "payment_intent.payment_failed":
          await this.paymentService.handlePaymentIntentFailed(
            event.data.object
          );
          break;
        case "charge.dispute.created":
          await this.paymentService.handleChargeDisputeCreated(
            event.data.object
          );
          break;
        case "payment_intent.canceled":
          await this.paymentService.handlePaymentIntentCanceled(
            event.data.object
          );
          break;
        case "checkout.session.expired":
          await this.paymentService.handleCheckoutSessionExpired(
            event.data.object
          );
          break;
        default:
          this.logger.warn(
            `Unhandled Stripe webhook event type: ${event.type}`
          );
      }
    } catch (err) {
      this.logger.error(
        `Webhook handler error for event ${event.id}: ${err instanceof Error ? err.message : "unknown error"}`
      );

      let lockReleased = false;
      try {
        await this.paymentService.releaseWebhookProcessing(event.id);
        lockReleased = true;
      } catch (releaseErr) {
        this.logger.error(
          `Failed to release idempotency key for event ${event.id}: ${releaseErr instanceof Error ? releaseErr.message : "unknown"}`
        );
      }

      if (lockReleased) {
        this.logger.warn(
          `[WEBHOOK_FAILED_WILL_RETRY] Event ${event.id} (${event.type}) failed processing. Returning 500 for Stripe retry.`
        );
        return res
          .status(500)
          .json({ received: false, error: "processing_failed" });
      }

      return res
        .status(503)
        .send("Service temporarily unavailable. Retry will be attempted.");
    }

    await this.paymentService.markWebhookSucceeded(event.id);

    return res.status(200).json({ received: true });
  }

  // check out paypal
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), VerifiedUserGuard)
  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @HttpCode(200)
  @Post("create-paypal-transaction")
  async createPaypalTransaction(
    @CurrentUser() user: JwtPayload,
    @Body() createPayment: CreateCheckoutSessionDto
  ): ReturnType<PaymentService["createPaypalTransaction"]> {
    const userId = user.userId;
    return this.paymentService.createPaypalTransaction(
      userId,
      createPayment.bookingCode
    );
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Post("/:id/finalize")
  async finalizePaypalTransaction(
    @Param("id") id: string,
    @CurrentUser() user: JwtPayload
  ): ReturnType<PaymentService["finalizePaypalTransaction"]> {
    // PayPal order IDs are 17-character uppercase alphanumeric strings.
    if (!/^[A-Z0-9]{5,22}$/.test(id)) {
      throw new BadRequestException("Invalid PayPal order ID format");
    }
    return this.paymentService.finalizePaypalTransaction(id, user.userId);
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Get("history")
  async getPaymentHistory(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryPaymentHistoryDto
  ): ReturnType<PaymentService["getPaymentHistory"]> {
    const userId = user.userId;
    return this.paymentService.getPaymentHistory(userId, query);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Post("cancel")
  async cancelPayment(
    @Body() dto: CancelPaymentDto,
    @CurrentUser() user: JwtPayload
  ): ReturnType<PaymentService["handlePaymentCancelled"]> {
    return this.paymentService.handlePaymentCancelled(
      user.userId,
      dto.bookingCode
    );
  }
}
