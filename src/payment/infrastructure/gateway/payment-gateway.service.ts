import { BadRequestException, Injectable } from "@nestjs/common";
import config from "@src/config/config";
import * as paypal from "@paypal/checkout-server-sdk";
import Stripe from "stripe";
import { PAYPAL_TIMEOUT_MS } from "@src/payment/payment.constants";
import type {
  PaypalHttpClient,
  PaypalSdk,
} from "@src/payment/types/payment.types";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";

export const paypalSdk: PaypalSdk = paypal;

@Injectable()
export class PaymentGatewayService {
  readonly stripe: Stripe;
  readonly paypalClient: PaypalHttpClient;

  constructor() {
    this.stripe = new Stripe(config.STRIPE_SECRET_KEY, {
      timeout: 15_000,
      maxNetworkRetries: 2,
    });

    const isPaypalLive = process.env.PAYPAL_ENV === "live";
    const paypalEnv = isPaypalLive
      ? new paypalSdk.core.LiveEnvironment(
          config.PAYPAL_CLIENT_ID,
          config.PAYPAL_CLIENT_SECRET
        )
      : new paypalSdk.core.SandboxEnvironment(
          config.PAYPAL_CLIENT_ID,
          config.PAYPAL_CLIENT_SECRET
        );
    this.paypalClient = new paypalSdk.core.PayPalHttpClient(paypalEnv);
  }

  verifyStripeWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    try {
      return this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        config.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      throw new BadRequestException(
        `Webhook Error: ${getPaymentErrorMessage(err)}`
      );
    }
  }

  withPaypalTimeout<T>(
    promise: Promise<{ result: T }>
  ): Promise<{ result: T }> {
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () =>
          reject(
            new Error(`PayPal request timed out after ${PAYPAL_TIMEOUT_MS}ms`)
          ),
        PAYPAL_TIMEOUT_MS
      );
      timeoutHandle.unref?.();
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
  }

  isPaypalAlreadyCapturedError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const paypalError = error as Record<string, unknown>;

    const details = paypalError.details;
    if (Array.isArray(details) && details.length > 0) {
      const firstDetail = details[0] as Record<string, unknown>;
      if (firstDetail.issue === "ORDER_ALREADY_CAPTURED") return true;
    }

    const message =
      typeof paypalError.message === "string" ? paypalError.message : "";
    return message.includes("ORDER_ALREADY_CAPTURED");
  }
}
