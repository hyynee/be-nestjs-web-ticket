import { Body, Controller, Headers, HttpCode, HttpStatus, Req, Res, Get, Param, Put } from '@nestjs/common';
import { PaymentService } from './payment.service';
import { AuthGuard } from '@nestjs/passport';
import { UseGuards, Post } from '@nestjs/common';
import { CurrentUser } from '@src/auth/decorator/currentUser.decorator';
import { JwtPayload } from '@src/auth/dto/jwt-payload.dto';
import { ApiBearerAuth } from '@nestjs/swagger';
import { CreateCheckoutSessionDto } from './dto/create-checkout.dto';
import Stripe from 'stripe';
@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) { }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(201)
  @Post('create-checkout-session')
  async createCheckoutSession(
    @CurrentUser() user: JwtPayload,
    @Body() createPayment: CreateCheckoutSessionDto,
  ) {
    const userId = user.userId;
    return this.paymentService.createCheckoutSession(userId, createPayment.bookingCode);
  }

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(@Headers('stripe-signature') signature: string, @Req() req: any, @Res() res: any) {
    let event: Stripe.Event;
    try {
      event = this.paymentService.verifyWebhook(req.body, signature);
    } catch (err) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const isFirstProcessing = await this.paymentService.acquireWebhookIdempotency(event.id);
    if (!isFirstProcessing) {
      return res.status(200).json({ received: true, deduplicated: true });
    }

    try {
      switch (event.type) {
        case 'payment_intent.succeeded':
          await this.paymentService.handlePaymentIntentSucceeded(
            event.data.object as Stripe.PaymentIntent
          );
          break;
        case 'checkout.session.completed':
          await this.paymentService.handleCheckoutSessionCompleted(
            event.data.object as Stripe.Checkout.Session
          );
          break;
        default:
          console.log(`Unhandled event type ${event.type}`);
      }

      return res.status(200).json({ received: true });
    } catch (err) {
      console.error('Webhook handler error:', err);
      return res.status(500).send(`Handler Error: ${err.message}`);
    }
  }

  // check out paypal
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @Post('create-paypal-transaction')
  async createPaypalTransaction(
    @CurrentUser() user: JwtPayload,
    @Body() createPayment: CreateCheckoutSessionDto,
  ) {
    const userId = user.userId;
    return this.paymentService.createPaypalTransaction(userId, createPayment.bookingCode);
  }


  @Put('/:id/pay')
  payCheckout(@Param('id') id: string) {
    return this.paymentService.payCheckout(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @Post('/:id/finalize')
  async finalizePaypalTransaction(
    @Param('id') id: string,
  ) {
    return this.paymentService.finalizePaypalTransaction(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @Get('history')
  async getPaymentHistory(
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.userId;
    return this.paymentService.getPaymentHistory(userId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @Post('cancel')
  async cancelPayment(
    @Body() dto: { bookingCode: string },
    @CurrentUser() user: JwtPayload
  ) {
    return this.paymentService.handlePaymentCancelled(user.userId, dto.bookingCode);
  }
}
