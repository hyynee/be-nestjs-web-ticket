import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import config from "@src/config/config";
import Stripe from "stripe";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Model, Types } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { Payment } from "@src/schemas/payment.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { TicketService } from "@src/ticket/ticket.service";
import { MailService } from "@src/services/mail.service";
import * as paypal from "@paypal/checkout-server-sdk";
import { RedisService } from "@src/redis/redis.service";
import type {
  BookingEventSummary,
  BookingForConfirmationMail,
  BookingZoneSummary,
  CreatedTicketForMail,
  PaymentRecord,
  PaypalCapture,
  PaypalHttpClient,
  PaypalOrderCaptureResponse,
  PaypalOrderCreateResponse,
  PaypalSdk,
} from "./types/payment.types";
import type { BookingConfirmationData } from "@src/types/booking-modules";
import type { QueryPaymentHistoryDto } from "./dto/query-payment-history.dto";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { QueueService } from "@src/queue/queue.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { CurrencyService } from "@src/currency/currency.service";

const paypalSdk = paypal as unknown as PaypalSdk;

const WEBHOOK_RELEASE_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

export type WebhookIdempotencyStatus = "new" | "processing" | "succeeded";

@Injectable()
export class PaymentService {
  private stripe: Stripe;
  private paypalClient: PaypalHttpClient;
  private readonly logger = new Logger(PaymentService.name);

  private static readonly CHECKOUT_DEDUP_SCRIPT = `
  local existing = redis.call('GET', KEYS[1])
  if existing then return {'existing', existing} end
  local acquired = redis.call('SET', KEYS[2], '1', 'NX', 'EX', 60)
  if acquired then return {'locked', ''} end
  existing = redis.call('GET', KEYS[1])
  if existing then return {'existing', existing} end
  return {'conflict', ''}
`;

  constructor(
    @InjectModel(Payment.name) private paymentModel: Model<any>,
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    private ticketService: TicketService,
    private mailService: MailService,
    private readonly redisService: RedisService,
    private readonly zoneGateway: ZoneGateway,
    private readonly queueService: QueueService,
    private readonly metricsService: MetricsService,
    private readonly currencyService: CurrencyService
  ) {
    this.stripe = new Stripe(config.STRIPE_SECRET_KEY, {
      timeout: 15_000,
      maxNetworkRetries: 2,
    });
    const isProduction = process.env.NODE_ENV === "production";
    const paypalEnv = isProduction
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

  private getPaymentIdempotencyKey(eventId: string): string {
    return `idemp:payment:${eventId}`;
  }

  private async enqueueRefundFailureAlert(
    bookingId: string,
    paymentRef: string,
    source: "stripe" | "paypal",
    errorMessage: string
  ): Promise<void> {
    this.metricsService.refundFailuresTotal.inc({ source });
    try {
      await this.queueService.addJob({
        type: "refund-failure-alert",
        payload: {
          bookingId,
          paymentRef,
          source,
          errorMessage,
          occurredAt: new Date().toISOString(),
        },
      });
    } catch (alertErr) {
      this.logger.error(
        `[ALERT_ENQUEUE_FAILED] Could not enqueue refund failure alert for bookingId=${bookingId}: ${this.getErrorMessage(alertErr)}`
      );
    }
  }

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }

  private readonly PAYPAL_TIMEOUT_MS = 15_000;

  private withPaypalTimeout<T>(
    promise: Promise<{ result: T }>
  ): Promise<{ result: T }> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(
              `PayPal request timed out after ${this.PAYPAL_TIMEOUT_MS}ms`
            )
          ),
        this.PAYPAL_TIMEOUT_MS
      )
    );
    return Promise.race([promise, timeout]);
  }

  private toObjectId(
    value:
      Types.ObjectId | string | { _id?: Types.ObjectId | string } | undefined,
    fieldName: string
  ): Types.ObjectId {
    if (value instanceof Types.ObjectId) {
      return value;
    }

    if (typeof value === "string") {
      return new Types.ObjectId(value);
    }

    const nestedId = value?._id;
    if (nestedId instanceof Types.ObjectId) {
      return nestedId;
    }
    if (typeof nestedId === "string") {
      return new Types.ObjectId(nestedId);
    }

    throw new BadRequestException(`${fieldName} is missing`);
  }

  private async safeDecrementConfirmedSoldCount(
    zoneId: Types.ObjectId,
    quantity: number,
    session: import("mongoose").ClientSession
  ): Promise<void> {
    await this.zoneModel.updateOne(
      { _id: zoneId },
      [
        {
          $set: {
            confirmedSoldCount: {
              $max: [{ $subtract: ["$confirmedSoldCount", quantity] }, 0],
            },
          },
        },
      ],
      { session }
    );
  }

  private async emitZoneTicketUpdate(zoneId: Types.ObjectId | string) {
    const zone = await this.zoneModel
      .findById(zoneId)
      .select("_id eventId capacity soldCount confirmedSoldCount")
      .lean();

    if (!zone) {
      return;
    }

    this.zoneGateway.emitZoneTicketUpdate({
      zoneId: zone._id,
      eventId: zone.eventId,
      capacity: zone.capacity,
      soldCount: zone.soldCount,
      confirmedSoldCount: zone.confirmedSoldCount || 0,
      availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
    });
  }

  // Reduced from 600s to 120s — a 10-minute dead-lock window on process crash left
  // bookings stuck as PENDING while Stripe retries were blocked by the processing key.
  // 120s covers the realistic worst-case processing time (DB transaction + QR generation).
  private readonly PROCESSING_TTL_SEC = 120;
  private readonly SUCCEEDED_TTL_SEC = 24 * 60 * 60;

  async acquireWebhookIdempotency(
    eventId: string
  ): Promise<WebhookIdempotencyStatus> {
    if (!eventId) {
      throw new BadRequestException("Missing Stripe event id");
    }

    const key = this.getPaymentIdempotencyKey(eventId);

    try {
      const acquired = await this.redisService.client.set(key, "processing", {
        NX: true,
        EX: this.PROCESSING_TTL_SEC,
      });

      if (acquired === "OK") return "new";

      const currentValue = await this.redisService.client.get(key);
      return currentValue === "succeeded" ? "succeeded" : "processing";
    } catch (error) {
      this.logger.warn(
        `Redis unavailable for webhook idempotency ${eventId}: ${this.getErrorMessage(error)} — falling back to DB`
      );
      throw new ServiceUnavailableException("__redis_down__");
    }
  }

  async checkWebhookIdempotencyFromDB(
    event: Stripe.Event
  ): Promise<WebhookIdempotencyStatus> {
    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object as Stripe.Checkout.Session;
        const paymentIntentId = session.payment_intent as string | undefined;
        if (paymentIntentId) {
          const booking = await this.bookingModel
            .findOne({
              stripePaymentIntentId: paymentIntentId,
              status: BookingStatus.CONFIRMED,
              paymentStatus: PaymentStatus.PAID,
              isDeleted: false,
            })
            .select("_id")
            .lean();
          if (booking) return "succeeded";
        }
      }

      if (event.type === "charge.refunded") {
        const charge = event.data.object as Stripe.Charge;
        const paymentIntentId = charge.payment_intent as string | undefined;
        if (paymentIntentId) {
          const payment = await this.paymentModel
            .findOne({
              stripePaymentIntentId: paymentIntentId,
              status: "refunded",
              isDeleted: false,
            })
            .select("_id")
            .lean();
          if (payment) return "succeeded";
        }
      }
    } catch (dbErr) {
      this.logger.error(
        `checkWebhookIdempotencyFromDB failed for event ${event.id}: ${this.getErrorMessage(dbErr)}`
      );
      throw dbErr;
    }

    this.logger.warn(
      `Processing webhook ${event.id} (${event.type}) without Redis dedup — MongoDB write guards are active`
    );
    return "new";
  }

  async markWebhookSucceeded(eventId: string): Promise<void> {
    const key = this.getPaymentIdempotencyKey(eventId);
    try {
      await this.redisService.client.set(key, "succeeded", {
        EX: this.SUCCEEDED_TTL_SEC,
      });
    } catch (err) {
      this.logger.warn(
        `Redis unavailable when marking webhook ${eventId} succeeded — event was processed, returning 200 regardless`
      );
    }
  }

  async releaseWebhookProcessing(eventId: string): Promise<void> {
    const key = this.getPaymentIdempotencyKey(eventId);
    try {
      await this.redisService.client.eval(WEBHOOK_RELEASE_SCRIPT, {
        keys: [key],
        arguments: ["processing"],
      });
    } catch {
      // Non-fatal — the 120s TTL on the processing key is the safety net
    }
  }

  private getPaypalLockKey(orderId: string): string {
    return `paypal:lock:${orderId}`;
  }

  private async acquirePaypalLock(
    orderId: string
  ): Promise<WebhookIdempotencyStatus> {
    const key = this.getPaypalLockKey(orderId);
    try {
      const acquired = await this.redisService.client.set(key, "processing", {
        NX: true,
        EX: this.PROCESSING_TTL_SEC,
      });
      if (acquired === "OK") return "new";
      const current = await this.redisService.client.get(key);
      return current === "succeeded" ? "succeeded" : "processing";
    } catch (error) {
      this.logger.error(
        `PayPal lock unavailable for order ${orderId}: ${this.getErrorMessage(error)}`
      );
      throw new ServiceUnavailableException(
        "Payment lock temporarily unavailable"
      );
    }
  }

  private async markPaypalSucceeded(orderId: string): Promise<void> {
    const key = this.getPaypalLockKey(orderId);
    await this.redisService.client.set(key, "succeeded", {
      EX: this.SUCCEEDED_TTL_SEC,
    });
  }

  private async releasePaypalLock(orderId: string): Promise<void> {
    const key = this.getPaypalLockKey(orderId);
    await this.redisService.client.eval(WEBHOOK_RELEASE_SCRIPT, {
      keys: [key],
      arguments: ["processing"],
    });
  }

  private isPaypalAlreadyCapturedError(error: unknown): boolean {
    if (!error || typeof error !== "object") return false;
    const e = error as Record<string, unknown>;

    const details = e["details"];
    if (Array.isArray(details) && details.length > 0) {
      const firstDetail = details[0] as Record<string, unknown>;
      if (firstDetail?.["issue"] === "ORDER_ALREADY_CAPTURED") return true;
    }

    const msg = typeof e["message"] === "string" ? e["message"] : "";
    if (msg.includes("ORDER_ALREADY_CAPTURED")) return true;

    return false;
  }

  async createCheckoutSession(userId: string, bookingCode: string) {
    const booking = await this.bookingModel
      .findOne({
        bookingCode: bookingCode,
        userId: new Types.ObjectId(userId),
        isDeleted: false,
      })
      .populate("eventId", "title thumbnail location startDate endDate")
      .populate("zoneId", "name price")
      .populate("areaId", "name");

    if (!booking) {
      throw new BadRequestException("Booking not found or unauthorized");
    }

    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException("Booking is completed or cancelled");
    }

    if (booking.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException("Booking already paid");
    }

    if (new Date() > booking.expiresAt) {
      throw new BadRequestException("Booking has expired");
    }

    const event = booking.eventId as unknown as BookingEventSummary;
    const zone = booking.zoneId as unknown as BookingZoneSummary;

    const thumbnailUrl =
      event.thumbnail ||
      "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=400";

    const dedupKey = `checkout:session:${booking._id.toString()}`;
    const dedupLockKey = `checkout:lock:${booking._id.toString()}`;
    const ttlSeconds = Math.max(
      Math.floor((booking.expiresAt.getTime() - Date.now()) / 1000),
      60
    );

    const luaResult = (await this.redisService.client.eval(
      PaymentService.CHECKOUT_DEDUP_SCRIPT,
      { keys: [dedupKey, dedupLockKey], arguments: [] }
    )) as string[];

    const luaStatus = luaResult[0];
    const luaValue = luaResult[1];

    if (luaStatus === "existing" && luaValue) {
      try {
        const existingSession =
          await this.stripe.checkout.sessions.retrieve(luaValue);
        if (existingSession.status === "open") {
          return {
            status: 200,
            message: "Checkout session already exists",
            checkoutUrl: existingSession.url,
          };
        }
      } catch {
        // Session expired or invalid — fall through to create a new one
      }
    }

    if (luaStatus === "conflict") {
      throw new ConflictException(
        "Checkout session creation already in progress — please wait a moment and retry"
      );
    }

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: "vnd",
          product_data: {
            name: `${event.title} - ${zone.name}`,
            description:
              booking.seats.length > 0
                ? `Ghế: ${booking.seats.join(", ")}`
                : `Số lượng: ${booking.quantity} vé`,
            images: [thumbnailUrl],
            metadata: {
              eventId: this.toObjectId(event._id, "eventId").toString(),
              zoneId: this.toObjectId(zone._id, "zoneId").toString(),
            },
          },
          unit_amount: Math.round(booking.pricePerTicket),
        },
        quantity: booking.seats.length || booking.quantity,
      },
    ];
    const session = await this.stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: booking.customerEmail,
      line_items: lineItems,
      phone_number_collection: { enabled: true },
      success_url: `${config.FRONTEND_URL}/my-bookings`,
      cancel_url: `${config.FRONTEND_URL}/booking/cancel?booking_code=${booking.bookingCode}`,
      metadata: {
        userId: userId,
        bookingCode: booking.bookingCode,
        bookingId: booking._id.toString(),
      },
      expires_at: Math.floor(booking.expiresAt.getTime() / 1000),
    });

    await this.redisService.client.set(dedupKey, session.id, {
      EX: ttlSeconds,
    });
    await this.redisService.client.del(dedupLockKey).catch(() => {});

    return {
      status: 200,
      message: "Checkout session created successfully",
      checkoutUrl: session.url,
    };
  }

  async createPaypalTransaction(userId: string, bookingCode: string) {
    const booking = await this.bookingModel
      .findOne({
        bookingCode: bookingCode,
        userId: new Types.ObjectId(userId),
        isDeleted: false,
      })
      .populate("eventId", "title thumbnail location startDate endDate")
      .populate("zoneId", "name price")
      .populate("areaId", "name");

    if (!booking) {
      throw new BadRequestException("Booking not found or unauthorized");
    }
    if (booking.status !== BookingStatus.PENDING) {
      throw new BadRequestException("Booking is completed or cancelled");
    }
    if (booking.paymentStatus === PaymentStatus.PAID) {
      throw new BadRequestException("Booking already paid");
    }
    if (new Date() > booking.expiresAt) {
      throw new BadRequestException("Booking has expired");
    }

    const event = booking.eventId as unknown as BookingEventSummary;

    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");

    const vndPerUsd = await this.currencyService.getVndPerUsd();
    const amountUSD = (booking.totalPrice / vndPerUsd).toFixed(2);
    if (parseFloat(amountUSD) < 0.01) {
      throw new BadRequestException(
        "Giá trị booking quá nhỏ để xử lý qua PayPal (tối thiểu ~230 VND)"
      );
    }

    const expiryIso = booking.expiresAt.toISOString();

    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: booking.bookingCode,
          description: `Ticket for ${event.title}`,
          amount: {
            currency_code: "USD",
            value: amountUSD,
          },
        },
      ],
      application_context: {
        return_url: `${config.FRONTEND_URL}/payment/paypal-success?bookingCode=${booking.bookingCode}`,
        cancel_url: `${config.FRONTEND_URL}/booking/cancel?bookingCode=${booking.bookingCode}`,
      },
    } as any);
    (request as any).body.expiry_time = expiryIso;

    try {
      const response = await this.withPaypalTimeout(
        this.paypalClient.execute<PaypalOrderCreateResponse>(request)
      );
      const order = response.result;

      await this.paymentModel.findOneAndUpdate(
        {
          bookingId: booking._id,
          paymentMethod: "paypal",
          status: "pending",
          isDeleted: false,
        },
        {
          $set: {
            userId: new Types.ObjectId(userId),
            paypalOrderId: order.id,
            metadata: { bookingCode, eventTitle: event.title, amountUSD },
          },
          $setOnInsert: {
            eventId: this.toObjectId(
              booking.eventId as
                Types.ObjectId | string | { _id?: Types.ObjectId | string },
              "eventId"
            ),
            amount: booking.totalPrice,
            currency: "VND",
            status: "pending",
            paymentMethod: "paypal",
          },
        },
        { upsert: true, new: true }
      );
      // Trả về order ID cho frontend
      const approveLink = order.links.find(
        (link: { rel?: string; href?: string }) => link.rel === "approve"
      );
      return {
        status: 200,
        message: "PayPal order created successfully",
        paypalOrderId: order.id,
        approvalUrl: approveLink?.href,
        amountUSD: amountUSD,
        bookingDetails: {
          bookingCode: booking.bookingCode,
          amount: booking.totalPrice,
          amountUSD: amountUSD,
          currency: "VND",
          customerEmail: booking.customerEmail,
          customerName: booking.customerName,
          customerPhone: booking.customerPhone,
        },
      };
    } catch (error) {
      this.logger.error(
        `PayPal order creation failed for booking ${bookingCode}: ${(error as Error)?.message || "unknown error"}`
      );
      throw new BadRequestException("Failed to create PayPal order");
    }
  }

  verifyWebhook(rawBody: Buffer, signature: string): Stripe.Event {
    const endpointSecret = config.STRIPE_WEBHOOK_SECRET;
    try {
      const event = this.stripe.webhooks.constructEvent(
        rawBody,
        signature,
        endpointSecret
      );
      return event;
    } catch (err) {
      throw new BadRequestException(
        `Webhook Error: ${this.getErrorMessage(err)}`
      );
    }
  }

  async handlePaymentIntentSucceeded(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    this.logger.debug(`payment_intent.succeeded received: ${paymentIntent.id}`);
  }

  private buildBookingConfirmationPayload(
    booking: BookingForConfirmationMail,
    currency: string,
    totalPrice: number,
    customerEmail?: string | null,
    customerName?: string | null
  ): BookingConfirmationData {
    return {
      email: customerEmail || booking.customerEmail,
      customerName: customerName || booking.customerName || "Khách hàng",
      bookingCode: booking.bookingCode,
      eventTitle: booking.eventId.title,
      eventLocation: booking.eventId.location,
      eventDate: booking.eventId.startDate,
      zoneName: booking.zoneId.name,
      seats: booking.seats || [],
      quantity: booking.quantity,
      totalPrice,
      currency,
      tickets: [],
    };
  }

  private async finalizeTicketsForDelivery(
    bookingCode: string,
    fallbackTickets: CreatedTicketForMail[],
    payload: BookingConfirmationData
  ): Promise<CreatedTicketForMail[]> {
    try {
      return await this.ticketService.generateMissingQRCodesForBooking(
        bookingCode
      );
    } catch (error) {
      this.logger.error(
        `Ticket QR finalization failed for booking ${bookingCode}: ${this.getErrorMessage(error)}`
      );
      await this.queueService.addJob({
        type: "finalize-ticket-delivery",
        payload,
      });
      return fallbackTickets;
    }
  }

  private async enqueueBookingConfirmation(
    data: BookingConfirmationData
  ): Promise<void> {
    await this.queueService.addJob({
      type: "send-booking-confirmation",
      payload: data,
      requestedAt: new Date().toISOString(),
    });
  }

  async handleCheckoutSessionCompleted(session: Stripe.Checkout.Session) {
    const { userId, bookingCode, bookingId } = session.metadata || {};

    if (!userId || !bookingCode || !bookingId) {
      throw new Error("Missing metadata in session");
    }

    const dbSession = await this.bookingModel.db.startSession();
    let bookingForMail: BookingForConfirmationMail | null = null;
    let tickets: CreatedTicketForMail[] = [];
    let shouldSendConfirmation = false;
    let ticketOwnerUserId: string | undefined;
    let changedZoneId: Types.ObjectId | null = null;
    let shouldRefund = false;
    let paymentIntentForRefund: string | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const updatedBooking = await this.bookingModel
          .findOneAndUpdate(
            {
              _id: bookingId,
              bookingCode,
              status: BookingStatus.PENDING,
              paymentStatus: PaymentStatus.UNPAID,
              isDeleted: false,
            },
            {
              status: BookingStatus.CONFIRMED,
              paymentStatus: PaymentStatus.PAID,
              paidAt: new Date(),
              stripePaymentIntentId:
                (session.payment_intent as string) || session.id,
              customerPhone: session.customer_details?.phone,
              customerName: session.customer_details?.name,
            },
            {
              new: true,
              select:
                "zoneId quantity bookingCode areaId eventId seats customerEmail customerName totalPrice userId",
              session: dbSession,
            }
          )
          .populate("eventId", "title location startDate endDate")
          .populate("zoneId", "name")
          .populate("areaId", "name");

        let booking = updatedBooking;

        if (!booking) {
          booking = await this.bookingModel
            .findOne({ _id: bookingId, bookingCode, isDeleted: false })
            .select(
              "zoneId quantity bookingCode areaId eventId seats customerEmail customerName totalPrice userId status paymentStatus"
            )
            .session(dbSession)
            .populate("eventId", "title location startDate endDate")
            .populate("zoneId", "name")
            .populate("areaId", "name");

          if (!booking) {
            throw new BadRequestException(
              "Booking not found during webhook processing"
            );
          }

          const alreadyConfirmedAndPaid =
            booking.status === BookingStatus.CONFIRMED &&
            booking.paymentStatus === PaymentStatus.PAID;

          if (!alreadyConfirmedAndPaid) {
            shouldRefund = true;
            paymentIntentForRefund =
              (session.payment_intent as string) || session.id;
            return;
          }
        } else {
          shouldSendConfirmation = true;
          if (booking.quantity > 0) {
            await this.zoneModel.findByIdAndUpdate(
              booking.zoneId,
              [
                {
                  $set: {
                    confirmedSoldCount: {
                      $min: [
                        { $add: ["$confirmedSoldCount", booking.quantity] },
                        "$capacity",
                      ],
                    },
                  },
                },
              ],
              { session: dbSession }
            );
            changedZoneId = booking.zoneId as Types.ObjectId;
          }
        }

        let rawEventId: Types.ObjectId;
        if (booking.eventId) {
          rawEventId = this.toObjectId(
            booking.eventId as
              Types.ObjectId | string | { _id?: Types.ObjectId | string },
            "eventId"
          );
        } else {
          const rawDoc = await this.bookingModel
            .findOne({ _id: bookingId, isDeleted: false }, "eventId")
            .session(dbSession)
            .lean();
          if (!rawDoc?.eventId) {
            throw new BadRequestException(
              "eventId reference missing from booking"
            );
          }
          rawEventId = rawDoc.eventId as Types.ObjectId;
          shouldSendConfirmation = false;
        }

        await this.paymentModel.findOneAndUpdate(
          {
            stripePaymentIntentId: session.payment_intent || session.id,
            isDeleted: false,
          },
          {
            userId: new Types.ObjectId(userId),
            bookingId: new Types.ObjectId(bookingId),
            eventId: rawEventId,
            amount: session.amount_total || 0,
            currency: session.currency || "vnd",
            status: "succeeded",
            paidAt: new Date(),
            paymentMethod: "card",
            stripePaymentIntentId: session.payment_intent || session.id,
            metadata: {
              sessionId: session.id,
              customerEmail: session.customer_details?.email,
              customerName: session.customer_details?.name,
              customerPhone: session.customer_details?.phone,
            },
          },
          { upsert: true, new: true, session: dbSession }
        );

        tickets = await this.ticketService.createTicketsFromBooking(
          bookingCode,
          dbSession
        );
        bookingForMail = booking as unknown as BookingForConfirmationMail;
        ticketOwnerUserId = booking.userId?.toString();
      });
    } catch (error) {
      this.logger.error(
        `Error handling checkout session ${session.id}: ${(error as Error)?.message || "unknown error"}`
      );
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (shouldRefund && paymentIntentForRefund) {
      this.metricsService.paymentsTotal.inc({
        provider: "stripe",
        status: "auto_refunded",
      });
      this.logger.error(
        `[MONEY_RISK] Stripe captured ${paymentIntentForRefund} but booking ${bookingId} is in non-payable state. Initiating auto-refund.`
      );
      try {
        await this.stripe.refunds.create({
          payment_intent: paymentIntentForRefund,
          metadata: {
            reason: "booking_cancelled_before_confirmation",
            bookingId,
          },
        });
        this.logger.warn(
          `[AUTO_REFUND] Refund issued for payment_intent=${paymentIntentForRefund}, bookingId=${bookingId}`
        );
      } catch (refundError) {
        this.logger.error(
          `[CRITICAL] Auto-refund FAILED for payment_intent=${paymentIntentForRefund}. MANUAL REFUND REQUIRED. Error: ${this.getErrorMessage(refundError)}`
        );
      }
      return;
    }

    if (!bookingForMail) {
      return;
    }

    const confirmedBooking = bookingForMail as BookingForConfirmationMail;
    const bookingCodeForPublish: string = confirmedBooking.bookingCode;

    try {
      await this.ticketService.publishTicketCreation(
        bookingCodeForPublish,
        tickets,
        ticketOwnerUserId
      );
    } catch (e) {
      this.logger.warn(
        `publishTicketCreation failed (payment confirmed, booking=${bookingCodeForPublish}): ${this.getErrorMessage(e)}`
      );
    }

    if (changedZoneId) {
      try {
        await this.emitZoneTicketUpdate(changedZoneId);
      } catch (e) {
        this.logger.warn(
          `emitZoneTicketUpdate failed: ${this.getErrorMessage(e)}`
        );
      }
    }

    this.metricsService.paymentsTotal.inc({
      provider: "stripe",
      status: "succeeded",
    });
    await this.redisService.client.del("stat:hot-events").catch(() => {});

    if (!shouldSendConfirmation) {
      return;
    }

    const confirmationPayload = this.buildBookingConfirmationPayload(
      confirmedBooking,
      session.currency || "vnd",
      session.amount_total || confirmedBooking.totalPrice || 0,
      session.customer_details?.email,
      session.customer_details?.name
    );

    tickets = await this.finalizeTicketsForDelivery(
      bookingCodeForPublish,
      tickets,
      confirmationPayload
    );

    const ticketMailData = tickets.map((ticket) => ({
      ticketCode: ticket.ticketCode,
      seatNumber: ticket.seatNumber,
      qrCode: ticket.qrCode || "",
    }));

    try {
      await this.enqueueBookingConfirmation({
        ...confirmationPayload,
        tickets: ticketMailData,
      });
    } catch (emailError) {
      this.logger.warn(
        `Failed to send Stripe confirmation email for booking ${confirmedBooking.bookingCode}: ${(emailError as Error)?.message || "unknown error"}`
      );
    }
  }

  async finalizePaypalTransaction(orderId: string, userId: string) {
    const lockStatus = await this.acquirePaypalLock(orderId);

    if (lockStatus === "processing") {
      throw new ConflictException(
        "Payment is currently being processed. Please wait and try again."
      );
    }
    let markedSucceeded = lockStatus === "succeeded";
    let captureSucceeded = false;

    try {
      const payment = await this.paymentModel
        .findOne({
          paypalOrderId: orderId,
          userId: new Types.ObjectId(userId),
          isDeleted: false,
        })
        .select("_id bookingId status currency metadata")
        .lean<PaymentRecord>()
        .exec();

      if (!payment) {
        throw new BadRequestException(
          "Payment record not found or unauthorized"
        );
      }

      const booking = await this.bookingModel
        .findById(payment.bookingId)
        .select("bookingCode status paymentStatus isDeleted")
        .lean<{
          bookingCode: string;
          status: BookingStatus;
          paymentStatus: PaymentStatus;
          isDeleted?: boolean;
        }>()
        .exec();

      if (!booking || booking.isDeleted) {
        throw new BadRequestException("Associated booking not found");
      }

      if (
        booking.status === BookingStatus.CANCELLED ||
        booking.status === BookingStatus.EXPIRED
      ) {
        throw new BadRequestException(
          "Booking has been cancelled or expired and cannot be finalized"
        );
      }

      if (markedSucceeded || payment.status === "succeeded") {
        if (
          booking.status !== BookingStatus.CONFIRMED ||
          booking.paymentStatus !== PaymentStatus.PAID
        ) {
          throw new BadRequestException(
            "Booking is not eligible for ticket issuance"
          );
        }
        const idemSession = await this.bookingModel.db.startSession();
        try {
          await idemSession.withTransaction(async () => {
            await this.ticketService.createTicketsFromBooking(
              booking.bookingCode,
              idemSession
            );
          });
        } finally {
          await idemSession.endSession();
        }
        return { status: 200, message: "Payment already finalized" };
      }

      const captureRequest = new paypalSdk.orders.OrdersCaptureRequest(orderId);
      captureRequest.requestBody({});

      let capture: PaypalOrderCaptureResponse;
      try {
        const response = await this.withPaypalTimeout(
          this.paypalClient.execute<PaypalOrderCaptureResponse>(captureRequest)
        );
        capture = response.result;
        captureSucceeded = true;
      } catch (captureError) {
        if (this.isPaypalAlreadyCapturedError(captureError)) {
          const refreshed = await this.paymentModel
            .findById(payment._id)
            .select("status")
            .lean<{ status: string }>()
            .exec();
          if (refreshed?.status === "succeeded") {
            await this.markPaypalSucceeded(orderId);
            markedSucceeded = true;
            return { status: 200, message: "Payment already finalized" };
          }

          this.logger.warn(
            `[PAYPAL_RECOVERY] ORDER_ALREADY_CAPTURED for orderId=${orderId} but payment.status=${refreshed?.status ?? "unknown"}. Attempting recovery.`
          );
          try {
            const getOrderRequest = new paypalSdk.orders.OrdersGetRequest(
              orderId
            );
            const orderResponse = await this.withPaypalTimeout(
              this.paypalClient.execute<PaypalOrderCaptureResponse>(
                getOrderRequest
              )
            );
            const completedOrder = orderResponse.result;
            if (completedOrder.status === "COMPLETED") {
              const captureDetail =
                completedOrder.purchase_units[0]?.payments?.captures?.[0];
              if (captureDetail) {
                await this.processPaypalPayment(
                  payment,
                  completedOrder,
                  captureDetail
                );
                await this.markPaypalSucceeded(orderId);
                markedSucceeded = true;
                this.logger.log(
                  `[PAYPAL_RECOVERY] Successfully recovered orderId=${orderId}`
                );
                return {
                  status: 200,
                  message: "Payment finalized after recovery",
                };
              }
            }
          } catch (recoveryErr) {
            this.logger.error(
              `[MONEY_RISK] PayPal recovery failed for orderId=${orderId}. MANUAL REVIEW REQUIRED. Error: ${this.getErrorMessage(recoveryErr)}`
            );
          }
        }
        this.logger.error(
          `PayPal capture failed for order ${orderId}: ${this.getErrorMessage(captureError)}`
        );
        throw new BadRequestException(
          `Failed to capture payment: ${this.getErrorMessage(captureError)}`
        );
      }

      if (capture.status === "COMPLETED") {
        const captureDetail = capture.purchase_units[0].payments.captures[0];

        await this.paymentModel
          .findByIdAndUpdate(payment._id, {
            $set: {
              "metadata.captureStatus": "PendingConfirmation",
              "metadata.captureId": captureDetail.id,
              "metadata.capturedAt": new Date().toISOString(),
            },
          })
          .catch((e: unknown) =>
            this.logger.warn(
              `[PAY-003] Could not write PendingConfirmation for orderId=${orderId}: ${this.getErrorMessage(e)}`
            )
          );

        try {
          await this.processPaypalPayment(payment, capture, captureDetail);
        } catch (processError) {
          this.logger.error(
            `[MONEY_RISK] PayPal capture SUCCEEDED for orderId=${orderId} (captureId=${captureDetail.id}) ` +
              `but DB write FAILED. PendingConfirmation record written. Lock held — reconciliation required. ` +
              `Error: ${this.getErrorMessage(processError)}`
          );
          // Re-throw so finally block runs; captureSucceeded=true prevents lock release
          throw processError;
        }
        await this.markPaypalSucceeded(orderId);
        markedSucceeded = true;
        return {
          status: 200,
          message: "PayPal payment completed",
          captureId: captureDetail.id,
        };
      } else {
        throw new BadRequestException(
          `Capture failed with status: ${capture.status}`
        );
      }
    } finally {
      if (!markedSucceeded) {
        if (captureSucceeded) {
          this.logger.error(
            `[PAY-002] PayPal lock for orderId=${orderId} intentionally kept as "processing" — capture succeeded, DB write failed. Manual or automated reconciliation required.`
          );
        } else {
          await this.releasePaypalLock(orderId).catch((e: unknown) => {
            this.logger.warn(
              `Failed to release PayPal lock for order ${orderId}: ${this.getErrorMessage(e)}`
            );
          });
        }
      }
    }
  }

  private async processPaypalPayment(
    payment: PaymentRecord,
    order: PaypalOrderCaptureResponse,
    captureOrAuth: PaypalCapture
  ) {
    const dbSession = await this.bookingModel.db.startSession();
    let bookingForMail: BookingForConfirmationMail | null = null;
    let tickets: CreatedTicketForMail[] = [];
    let shouldSendConfirmation = false;
    let ticketOwnerUserId: string | undefined;
    let changedZoneId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const updatedBooking = await this.bookingModel
          .findOneAndUpdate(
            {
              _id: payment.bookingId,
              status: BookingStatus.PENDING,
              paymentStatus: PaymentStatus.UNPAID,
              isDeleted: false,
            },
            {
              status: BookingStatus.CONFIRMED,
              paymentStatus: PaymentStatus.PAID,
              paidAt: new Date(),
            },
            {
              new: true,
              select:
                "zoneId quantity bookingCode areaId eventId seats customerEmail customerName totalPrice userId",
              session: dbSession,
            }
          )
          .populate("eventId", "title location startDate endDate")
          .populate("zoneId", "name")
          .populate("areaId", "name");

        if (!updatedBooking) {
          this.logger.error(
            `[MONEY_RISK] PayPal captured order but booking ${payment.bookingId?.toString()} is no longer PENDING/UNPAID. Initiating auto-refund.`,
            { alert: "MONEY_RISK" }
          );
          // Mirror the Stripe auto-refund path: money was captured but booking cannot be confirmed.
          try {
            const refundRequest = new paypalSdk.payments.CapturesRefundRequest(
              captureOrAuth.id
            );
            refundRequest.requestBody({
              note_to_payer: "Booking no longer available",
            });
            await this.withPaypalTimeout(
              this.paypalClient.execute(refundRequest)
            );
            this.logger.warn(
              `[AUTO_REFUND] PayPal refund issued for captureId=${captureOrAuth.id}`
            );
          } catch (refundErr) {
            this.logger.error(
              `[CRITICAL] PayPal auto-refund FAILED for captureId=${captureOrAuth.id}. MANUAL REFUND REQUIRED. Error: ${this.getErrorMessage(refundErr)}`,
              { alert: "MONEY_RISK" }
            );
          }
          throw new BadRequestException(
            "Booking is no longer available. Payment was captured and refund has been initiated."
          );
        }

        shouldSendConfirmation = true;

        if (updatedBooking.quantity > 0) {
          await this.zoneModel.findByIdAndUpdate(
            updatedBooking.zoneId,
            [
              {
                $set: {
                  confirmedSoldCount: {
                    $min: [
                      {
                        $add: ["$confirmedSoldCount", updatedBooking.quantity],
                      },
                      "$capacity",
                    ],
                  },
                },
              },
            ],
            { session: dbSession }
          );
          changedZoneId = updatedBooking.zoneId as Types.ObjectId;
        }

        await this.paymentModel.findByIdAndUpdate(
          payment._id,
          {
            status: "succeeded",
            paidAt: new Date(),
            paypalCaptureId: captureOrAuth.id,
            metadata: {
              ...(payment.metadata ?? {}),
              orderId: order.id,
              orderStatus: order.status,
              authorizationId: captureOrAuth.id,
              captureStatus: captureOrAuth.status,
              capturedAt: new Date().toISOString(),
            },
          },
          { session: dbSession }
        );

        tickets = await this.ticketService.createTicketsFromBooking(
          updatedBooking.bookingCode,
          dbSession
        );
        bookingForMail =
          updatedBooking as unknown as BookingForConfirmationMail;
        ticketOwnerUserId = updatedBooking.userId?.toString();
      });
    } catch (error) {
      const paymentId =
        payment && typeof payment === "object" && "_id" in payment
          ? (() => {
              const rawId = (payment as { _id?: unknown })._id;
              if (rawId instanceof Types.ObjectId) {
                return rawId.toString();
              }
              if (typeof rawId === "string") {
                return rawId;
              }
              return "unknown";
            })()
          : "unknown";
      this.logger.error(
        `PayPal finalize failed for payment ${paymentId}: ${(error as Error)?.message || "unknown error"}`
      );
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (!bookingForMail) {
      return;
    }

    const confirmedBooking = bookingForMail as BookingForConfirmationMail;
    const bookingCodeForPublish: string = confirmedBooking.bookingCode;

    try {
      await this.ticketService.publishTicketCreation(
        bookingCodeForPublish,
        tickets,
        ticketOwnerUserId
      );
    } catch (e) {
      this.logger.warn(
        `publishTicketCreation failed (PayPal payment confirmed, booking=${bookingCodeForPublish}): ${this.getErrorMessage(e)}`
      );
    }

    if (changedZoneId) {
      try {
        await this.emitZoneTicketUpdate(changedZoneId);
      } catch (e) {
        this.logger.warn(
          `emitZoneTicketUpdate failed: ${this.getErrorMessage(e)}`
        );
      }
    }

    if (!shouldSendConfirmation) {
      return;
    }

    const confirmationPayload = this.buildBookingConfirmationPayload(
      confirmedBooking,
      payment.currency,
      confirmedBooking.totalPrice
    );

    tickets = await this.finalizeTicketsForDelivery(
      bookingCodeForPublish,
      tickets,
      confirmationPayload
    );

    const ticketMailData = tickets.map((ticket) => ({
      ticketCode: ticket.ticketCode,
      seatNumber: ticket.seatNumber,
      qrCode: ticket.qrCode || "",
    }));

    try {
      await this.enqueueBookingConfirmation({
        ...confirmationPayload,
        tickets: ticketMailData,
      });
    } catch (emailError) {
      this.logger.warn(
        `Failed to send PayPal confirmation email for booking ${confirmedBooking.bookingCode}: ${(emailError as Error)?.message || "unknown error"}`
      );
    }

    // Fix: was "stat:hotEventsByRevenue" (wrong key) via cacheManager (wrong client — Keyv prefix mismatch).
    // StatisticalService writes under "stat:hot-events" via raw Redis client.
    await this.redisService.client.del("stat:hot-events").catch(() => {});
  }

  async getPaymentHistory(userId: string, query: QueryPaymentHistoryDto = {}) {
    const {
      page = 1,
      limit = 10,
      status,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;

    const allowedStatuses = new Set([
      "pending",
      "processing",
      "succeeded",
      "failed",
      "canceled",
      "refunded",
    ]);
    const allowedSortFields = new Set(["createdAt", "paidAt", "updatedAt"]);

    if (status && !allowedStatuses.has(status)) {
      throw new BadRequestException("Invalid payment status filter");
    }

    if (!allowedSortFields.has(sortBy)) {
      throw new BadRequestException("Invalid sortBy field");
    }

    const currentPage =
      Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
    const itemsPerPage =
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), 100)
        : 10;
    const skip = (currentPage - 1) * itemsPerPage;

    const sortDirection: 1 | -1 = sortOrder === "asc" ? 1 : -1;
    const sort: Record<string, 1 | -1> = { [sortBy]: sortDirection };

    const filter: {
      userId: Types.ObjectId;
      isDeleted: boolean;
      status?: string;
    } = {
      userId: new Types.ObjectId(userId),
      isDeleted: false,
    };

    if (status) {
      filter.status = status;
    }

    const [payments, totalItems] = await Promise.all([
      this.paymentModel
        .find(filter)
        .populate({
          path: "bookingId",
          populate: [
            { path: "eventId", select: "title location startDate" },
            { path: "zoneId", select: "name price" },
          ],
        })
        .sort(sort)
        .skip(skip)
        .limit(itemsPerPage),
      this.paymentModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(totalItems / itemsPerPage);

    return {
      success: true,
      data: payments,
      meta: {
        currentPage,
        itemsPerPage,
        totalItems,
        totalPages,
        hasPreviousPage: currentPage > 1,
        hasNextPage: currentPage < totalPages,
      },
    };
  }

  async handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
    const paymentIntentId = charge.payment_intent as string | null;
    if (!paymentIntentId) return;

    if (!charge.amount_refunded || charge.amount_refunded <= 0) return;

    const isPartialRefund =
      charge.amount !== undefined &&
      charge.amount > 0 &&
      charge.amount_refunded < charge.amount;

    const isZeroDecimal = charge.currency?.toLowerCase() === "vnd";
    const cumulativeRefundAmount = charge.amount_refunded
      ? isZeroDecimal
        ? charge.amount_refunded
        : charge.amount_refunded / 100
      : 0;

    const dbSession = await this.bookingModel.db.startSession();
    let changedZoneId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const booking = await this.bookingModel
          .findOne({
            stripePaymentIntentId: paymentIntentId,
            paymentStatus: PaymentStatus.PAID,
            status: BookingStatus.CONFIRMED,
            isDeleted: false,
          })
          .session(dbSession);

        if (!booking) return;

        const previousRefunded = booking.totalRefunded || 0;
        const deltaRefundAmount = cumulativeRefundAmount - previousRefunded;

        if (deltaRefundAmount <= 0) return;

        booking.totalRefunded = cumulativeRefundAmount;
        booking.refundHistory.push({
          amount: deltaRefundAmount,
          refundedAt: new Date(),
        });

        if (isPartialRefund) {
          await booking.save({ session: dbSession });

          await this.paymentModel.findOneAndUpdate(
            { stripePaymentIntentId: paymentIntentId, isDeleted: false },
            {
              status: "partially_refunded",
              refundedAt: new Date(),
              refundAmount: cumulativeRefundAmount,
            },
            { session: dbSession }
          );
        } else {
          booking.paymentStatus = PaymentStatus.REFUNDED;
          booking.status = BookingStatus.CANCELLED;
          booking.cancelledAt = new Date();
          booking.cancellationReason = "Refunded via Stripe";
          await booking.save({ session: dbSession });

          await this.ticketModel.updateMany(
            { bookingId: booking._id, status: "valid", isDeleted: false },
            { $set: { status: "cancelled", cancelledAt: new Date() } },
            { session: dbSession }
          );

          if (booking.quantity > 0) {
            await this.zoneModel.updateOne(
              { _id: booking.zoneId as Types.ObjectId },
              [
                {
                  $set: {
                    soldCount: {
                      $max: [
                        { $subtract: ["$soldCount", booking.quantity] },
                        0,
                      ],
                    },
                  },
                },
              ],
              { session: dbSession }
            );

            await this.safeDecrementConfirmedSoldCount(
              booking.zoneId as Types.ObjectId,
              booking.quantity,
              dbSession
            );

            changedZoneId = booking.zoneId as Types.ObjectId;
          }

          await this.paymentModel.findOneAndUpdate(
            { stripePaymentIntentId: paymentIntentId, isDeleted: false },
            {
              status: "refunded",
              refundedAt: new Date(),
              refundAmount: cumulativeRefundAmount,
            },
            { session: dbSession }
          );
        }
      });
    } finally {
      await dbSession.endSession();
    }

    if (changedZoneId) {
      await this.emitZoneTicketUpdate(changedZoneId);
    }

    // Fix: was "stat:hotEventsByRevenue" (wrong key) via cacheManager (wrong client — Keyv prefix mismatch).
    // StatisticalService writes under "stat:hot-events" via raw Redis client.
    await this.redisService.client.del("stat:hot-events").catch(() => {});
  }

  async handlePaymentCancelled(userId: string, bookingCode: string) {
    const normalizedCode = bookingCode.trim().toUpperCase();
    const dbSession = await this.bookingModel.db.startSession();
    let cancelled = false;
    let changedZoneId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const booking = await this.bookingModel.findOneAndUpdate(
          {
            bookingCode: normalizedCode,
            userId: new Types.ObjectId(userId),
            status: BookingStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            isDeleted: false,
          },
          {
            $set: {
              status: BookingStatus.CANCELLED,
              cancellationReason: "Payment cancelled by user",
            },
          },
          { new: true, session: dbSession }
        );

        if (!booking) {
          return;
        }

        await this.zoneModel.updateOne(
          { _id: booking.zoneId as Types.ObjectId },
          [
            {
              $set: {
                soldCount: {
                  $max: [{ $subtract: ["$soldCount", booking.quantity] }, 0],
                },
              },
            },
          ],
          { session: dbSession }
        );
        changedZoneId = booking.zoneId as Types.ObjectId;
        cancelled = true;
      });
    } finally {
      await dbSession.endSession();
    }

    if (!cancelled) {
      return;
    }

    if (changedZoneId) {
      await this.emitZoneTicketUpdate(changedZoneId);
    }

    return {
      status: 200,
      message: "Payment cancelled successfully",
    };
  }

  // ---------------------------------------------------------------------------
  // Stripe webhook handlers for previously unhandled event types
  // ---------------------------------------------------------------------------

  async handlePaymentIntentFailed(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    this.logger.warn(
      `payment_intent.payment_failed: id=${paymentIntent.id} reason=${paymentIntent.last_payment_error?.message ?? "unknown"}`
    );
    // Find the booking tied to this payment intent and log the failure.
    // A notification to the user is outside scope here; the booking stays PENDING
    // so the user can retry or the expiry cron will clean it up.
    await this.paymentModel
      .updateOne(
        { stripePaymentIntentId: paymentIntent.id, isDeleted: false },
        {
          $set: {
            status: "failed",
            failureReason: paymentIntent.last_payment_error?.message,
          },
        }
      )
      .catch((err: unknown) =>
        this.logger.error(
          `handlePaymentIntentFailed: DB update failed: ${this.getErrorMessage(err)}`
        )
      );
  }

  async handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
    const paymentIntentId =
      typeof dispute.payment_intent === "string"
        ? dispute.payment_intent
        : dispute.payment_intent?.id;

    this.logger.error(
      `charge.dispute.created: disputeId=${dispute.id} paymentIntentId=${paymentIntentId} reason=${dispute.reason} amount=${dispute.amount}`
    );

    if (!paymentIntentId) return;

    const booking = await this.bookingModel
      .findOne({ stripePaymentIntentId: paymentIntentId, isDeleted: false })
      .select("_id bookingCode");

    if (!booking) {
      this.logger.warn(
        `handleChargeDisputeCreated: no booking found for paymentIntentId=${paymentIntentId}`
      );
      return;
    }

    await this.bookingModel.updateOne(
      { _id: booking._id },
      {
        $set: {
          disputeId: dispute.id,
          disputeReason: dispute.reason,
          disputeStatus: "open",
        },
      }
    );

    const dueBySec = dispute.evidence_details?.due_by;
    const dueByIso = dueBySec
      ? new Date(dueBySec * 1000).toISOString()
      : "unknown (check Stripe dashboard)";

    this.logger.error(
      `FRAUD ALERT: Booking ${booking.bookingCode} has an open dispute (${dispute.reason}). Evidence due: ${dueByIso}`
    );

    await this.enqueueRefundFailureAlert(
      booking._id.toString(),
      paymentIntentId,
      "stripe",
      `Dispute opened — reason: ${dispute.reason}, evidence due: ${dueByIso}, amount: ${dispute.amount}`
    );
  }

  async handlePaymentIntentCanceled(
    paymentIntent: Stripe.PaymentIntent
  ): Promise<void> {
    this.logger.warn(`payment_intent.canceled: id=${paymentIntent.id}`);

    // If the booking is CONFIRMED+PAID and the PaymentIntent was later cancelled
    // (e.g., via Stripe dashboard), flag it for manual review — do NOT automatically
    // refund because the admin may have legitimate reasons.
    const booking = await this.bookingModel
      .findOne({ stripePaymentIntentId: paymentIntent.id, isDeleted: false })
      .select("_id bookingCode status paymentStatus");

    if (!booking) return;

    if (booking.status === BookingStatus.CONFIRMED) {
      this.logger.error(
        `ALERT: PaymentIntent ${paymentIntent.id} canceled but booking ${booking.bookingCode} is CONFIRMED. Manual review required.`
      );
    }
  }

  /**
   * Issues a real money refund for an admin-cancelled confirmed+paid booking.
   * Called by BookingService after adminCancelBooking transaction commits.
   * Errors are logged as CRITICAL but never thrown — the DB cancel is committed regardless.
   */
  async issueAdminRefund(
    bookingId: string,
    stripePaymentIntentId: string | undefined,
    adminId: string,
    reason: string
  ): Promise<void> {
    if (stripePaymentIntentId) {
      try {
        await this.stripe.refunds.create(
          {
            payment_intent: stripePaymentIntentId,
            metadata: { reason, bookingId, adminId, source: "admin_cancel" },
          },
          { idempotencyKey: `admin-refund:${bookingId}` }
        );
        this.logger.log(
          `[REFUND] Stripe admin refund issued: bookingId=${bookingId}, pi=${stripePaymentIntentId}`
        );
        await this.bookingModel.updateOne(
          {
            _id: new Types.ObjectId(bookingId),
            paymentStatus: PaymentStatus.REFUND_PENDING,
          },
          { $set: { paymentStatus: PaymentStatus.REFUNDED } }
        );
      } catch (err) {
        const errMsg = this.getErrorMessage(err);
        this.logger.error(
          `[CRITICAL] Stripe admin refund FAILED: bookingId=${bookingId}. MANUAL REFUND REQUIRED. Error: ${errMsg}`,
          { alert: "MONEY_RISK" }
        );
        await this.bookingModel.updateOne(
          {
            _id: new Types.ObjectId(bookingId),
            paymentStatus: PaymentStatus.REFUND_PENDING,
          },
          { $set: { paymentStatus: PaymentStatus.PAID } }
        );
        await this.enqueueRefundFailureAlert(
          bookingId,
          stripePaymentIntentId,
          "stripe",
          errMsg
        );
      }
      return;
    }

    // No Stripe payment intent → check for PayPal capture
    const paymentDoc = await this.paymentModel
      .findOne({
        bookingId: new Types.ObjectId(bookingId),
        paymentMethod: "paypal",
        status: "succeeded",
        isDeleted: false,
      })
      .select("paypalCaptureId")
      .lean<{ paypalCaptureId?: string }>();

    if (!paymentDoc?.paypalCaptureId) {
      this.logger.warn(
        `issueAdminRefund: no refundable payment found for bookingId=${bookingId}`
      );
      await this.bookingModel.updateOne(
        {
          _id: new Types.ObjectId(bookingId),
          paymentStatus: PaymentStatus.REFUND_PENDING,
        },
        { $set: { paymentStatus: PaymentStatus.PAID } }
      );
      return;
    }

    try {
      const refundRequest = new paypalSdk.payments.CapturesRefundRequest(
        paymentDoc.paypalCaptureId
      );
      refundRequest.requestBody({
        note_to_payer: reason || "Admin cancellation",
      });
      await this.withPaypalTimeout(this.paypalClient.execute(refundRequest));
      this.logger.log(
        `[REFUND] PayPal admin refund issued: bookingId=${bookingId}, captureId=${paymentDoc.paypalCaptureId}`
      );
      await this.bookingModel.updateOne(
        {
          _id: new Types.ObjectId(bookingId),
          paymentStatus: PaymentStatus.REFUND_PENDING,
        },
        { $set: { paymentStatus: PaymentStatus.REFUNDED } }
      );
    } catch (err) {
      const errMsg = this.getErrorMessage(err);
      this.logger.error(
        `[CRITICAL] PayPal admin refund FAILED: bookingId=${bookingId}, captureId=${paymentDoc.paypalCaptureId}. MANUAL REFUND REQUIRED. Error: ${errMsg}`,
        { alert: "MONEY_RISK" }
      );
      await this.enqueueRefundFailureAlert(
        bookingId,
        paymentDoc.paypalCaptureId ?? "unknown",
        "paypal",
        errMsg
      );
      await this.bookingModel.updateOne(
        {
          _id: new Types.ObjectId(bookingId),
          paymentStatus: PaymentStatus.REFUND_PENDING,
        },
        { $set: { paymentStatus: PaymentStatus.PAID } }
      );
    }
  }

  async handleCheckoutSessionExpired(
    session: Stripe.Checkout.Session
  ): Promise<void> {
    this.logger.debug(`checkout.session.expired: id=${session.id}`);
    const { bookingId } = session.metadata || {};
    if (!bookingId) return;

    const dedupKey = `checkout:session:${bookingId}`;
    await this.redisService.client.del(dedupKey).catch(() => {});
  }
}
