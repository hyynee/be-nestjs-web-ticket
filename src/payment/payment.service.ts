import {
  BadRequestException,
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
import type { QueryPaymentHistoryDto } from "./dto/query-payment-history.dto";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { UserEventsService } from "@src/events/user-event.services";

const paypalSdk = paypal as unknown as PaypalSdk;

@Injectable()
export class PaymentService {
  private stripe: Stripe;
  private paypalClient: PaypalHttpClient;
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    @InjectModel(Payment.name) private paymentModel: Model<any>,
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    private ticketService: TicketService,
    private mailService: MailService,
    private readonly redisService: RedisService,
    private readonly zoneGateway: ZoneGateway,
    private readonly userEventsService: UserEventsService
  ) {
    this.stripe = new Stripe(config.STRIPE_SECRET_KEY);
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

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "unknown error";
  }

  private toObjectId(
    value:
      | Types.ObjectId
      | string
      | { _id?: Types.ObjectId | string }
      | undefined,
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

  async acquireWebhookIdempotency(eventId: string): Promise<boolean> {
    if (!eventId) {
      throw new BadRequestException("Missing Stripe event id");
    }

    try {
      const result = await this.redisService.client.set(
        this.getPaymentIdempotencyKey(eventId),
        "1",
        { NX: true, EX: 24 * 60 * 60 }
      );

      return result === "OK";
    } catch (error) {
      this.logger.error(
        `Payment idempotency unavailable for event ${eventId}: ${(error as Error)?.message || "unknown error"}`
      );
      throw new ServiceUnavailableException(
        "Payment deduplication is temporarily unavailable"
      );
    }
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

    // Check booking expiration
    if (new Date() > booking.expiresAt) {
      booking.status = BookingStatus.EXPIRED;
      await booking.save();
      throw new BadRequestException("Booking has expired");
    }

    const event = booking.eventId as unknown as BookingEventSummary;
    const zone = booking.zoneId as unknown as BookingZoneSummary;

    const thumbnailUrl =
      event.thumbnail ||
      "https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=400";

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
              zoneId: this.toObjectId(zone._id, "zoneId").toString(), // Stripe metadata requires string
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
      shipping_address_collection: {
        allowed_countries: ["US", "CA", "KE", "VN"],
      },
      shipping_options: [
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: 0,
              currency: "vnd",
            },
            display_name: "Free shipping",
            delivery_estimate: {
              minimum: {
                unit: "business_day",
                value: 5,
              },
              maximum: {
                unit: "business_day",
                value: 7,
              },
            },
          },
        },
        {
          shipping_rate_data: {
            type: "fixed_amount",
            fixed_amount: {
              amount: 30000,
              currency: "vnd",
            },
            display_name: "Next day air",
            // Delivers in exactly 1 business day
            delivery_estimate: {
              minimum: {
                unit: "business_day",
                value: 1,
              },
              maximum: {
                unit: "business_day",
                value: 1,
              },
            },
          },
        },
      ],
      line_items: lineItems,
      phone_number_collection: {
        enabled: true,
      },
      success_url: `${config.FRONTEND_URL}/my-bookings`,
      cancel_url: `${config.FRONTEND_URL}/booking/cancel?booking_code=${booking.bookingCode}`,
      metadata: {
        userId: userId,
        bookingCode: booking.bookingCode,
        bookingId: booking._id.toString(),
      },
      expires_at: Math.floor(booking.expiresAt.getTime() / 1000),
    });
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
      booking.status = BookingStatus.EXPIRED;
      await booking.save();
      throw new BadRequestException("Booking has expired");
    }

    const event = booking.eventId as unknown as BookingEventSummary;

    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");

    const amountUSD = (booking.totalPrice / 23000).toFixed(2);

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
    });

    try {
      const response =
        await this.paypalClient.execute<PaypalOrderCreateResponse>(request);
      const order = response.result;

      await this.paymentModel.create({
        userId: new Types.ObjectId(userId),
        bookingId: booking._id,
        eventId: this.toObjectId(
          booking.eventId as
            | Types.ObjectId
            | string
            | { _id?: Types.ObjectId | string },
          "eventId"
        ),
        amount: booking.totalPrice,
        currency: "VND",
        status: "pending",
        paymentMethod: "paypal",
        paypalOrderId: order.id,
        metadata: {
          bookingCode: bookingCode,
          eventTitle: event.title,
          amountUSD: amountUSD,
        },
      });
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

  handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): void {
    this.logger.debug(`payment_intent.succeeded received: ${paymentIntent.id}`);
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
            throw new BadRequestException(
              "Booking is not eligible for payment confirmation"
            );
          }
        } else {
          shouldSendConfirmation = true;
          if (booking.quantity > 0) {
            await this.zoneModel.findByIdAndUpdate(
              booking.zoneId,
              { $inc: { confirmedSoldCount: booking.quantity } },
              { session: dbSession }
            );
            changedZoneId = booking.zoneId as Types.ObjectId;
          }
        }

        await this.paymentModel.findOneAndUpdate(
          { stripePaymentIntentId: session.payment_intent || session.id },
          (() => {
            return {
              userId: new Types.ObjectId(userId),
              bookingId: new Types.ObjectId(bookingId),
              eventId: this.toObjectId(
                booking.eventId as
                  | Types.ObjectId
                  | string
                  | { _id?: Types.ObjectId | string }
                  | undefined,
                "eventId"
              ),
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
            };
          })(),
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

    if (!bookingForMail) {
      return;
    }

    const confirmedBooking = bookingForMail as BookingForConfirmationMail;
    const bookingCodeForPublish: string = confirmedBooking.bookingCode;

    await this.ticketService.publishTicketCreation(
      bookingCodeForPublish,
      tickets,
      ticketOwnerUserId
    );

    if (changedZoneId) {
      await this.emitZoneTicketUpdate(changedZoneId);
    }

    if (!shouldSendConfirmation) {
      return;
    }

    const ticketMailData = tickets.map((ticket) => ({
      ticketCode: ticket.ticketCode,
      seatNumber: ticket.seatNumber,
      qrCode: ticket.qrCode || "",
    }));

    try {
      this.userEventsService.emitSendBookingConfirmation({
        email:
          session.customer_details?.email || confirmedBooking.customerEmail,
        customerName:
          session.customer_details?.name ||
          confirmedBooking.customerName ||
          "Khách hàng",
        bookingCode: confirmedBooking.bookingCode,
        eventTitle: confirmedBooking.eventId.title,
        eventLocation: confirmedBooking.eventId.location,
        eventDate: confirmedBooking.eventId.startDate,
        zoneName: confirmedBooking.zoneId.name,
        seats: confirmedBooking.seats || [],
        quantity: confirmedBooking.quantity,
        totalPrice: session.amount_total || confirmedBooking.totalPrice || 0,
        currency: session.currency || "vnd",
        tickets: ticketMailData,
      });
    } catch (emailError) {
      this.logger.warn(
        `Failed to send Stripe confirmation email for booking ${confirmedBooking.bookingCode}: ${(emailError as Error)?.message || "unknown error"}`
      );
    }
  }

  async finalizePaypalTransaction(orderId: string, userId: string) {
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
      throw new BadRequestException("Payment record not found or unauthorized");
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

    if (payment.status === "succeeded") {
      if (
        booking.status !== BookingStatus.CONFIRMED ||
        booking.paymentStatus !== PaymentStatus.PAID
      ) {
        throw new BadRequestException(
          "Booking is not eligible for ticket issuance"
        );
      }

      if (booking.bookingCode) {
        await this.ticketService.createTicketsFromBooking(booking.bookingCode);
      }
      return { status: 200, message: "Payment already finalized" };
    }
    try {
      const captureRequest = new paypalSdk.orders.OrdersCaptureRequest(orderId);
      captureRequest.requestBody({});

      const response =
        await this.paypalClient.execute<PaypalOrderCaptureResponse>(
          captureRequest
        );
      const capture = response.result;

      if (capture.status === "COMPLETED") {
        const captureDetail = capture.purchase_units[0].payments.captures[0];
        await this.processPaypalPayment(payment, capture, captureDetail);
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
    } catch (error) {
      this.logger.error(
        `PayPal capture failed for order ${orderId}: ${this.getErrorMessage(error)}`
      );
      throw new BadRequestException(
        `Failed to capture payment: ${this.getErrorMessage(error)}`
      );
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
        const booking = await this.bookingModel
          .findById(payment.bookingId)
          .session(dbSession)
          .populate("eventId", "title location startDate endDate")
          .populate("zoneId", "name")
          .populate("areaId", "name");

        if (!booking) {
          throw new BadRequestException("Associated booking not found");
        }

        const wasAlreadyPaid = booking.paymentStatus === PaymentStatus.PAID;
        if (wasAlreadyPaid && booking.status !== BookingStatus.CONFIRMED) {
          throw new BadRequestException(
            "Booking is not eligible for repeated capture"
          );
        }

        if (!wasAlreadyPaid) {
          if (
            booking.status !== BookingStatus.PENDING ||
            booking.paymentStatus !== PaymentStatus.UNPAID
          ) {
            throw new BadRequestException(
              "Booking is not eligible for payment capture"
            );
          }

          booking.paymentStatus = PaymentStatus.PAID;
          booking.status = BookingStatus.CONFIRMED;
          booking.paidAt = new Date();

          if (booking.quantity > 0) {
            await this.zoneModel.findByIdAndUpdate(
              booking.zoneId,
              { $inc: { confirmedSoldCount: booking.quantity } },
              { session: dbSession }
            );
            changedZoneId = booking.zoneId as Types.ObjectId;
          }

          await booking.save({ session: dbSession });
          shouldSendConfirmation = true;
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
          booking.bookingCode,
          dbSession
        );
        bookingForMail = booking as unknown as BookingForConfirmationMail;
        ticketOwnerUserId = booking.userId?.toString();
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

    await this.ticketService.publishTicketCreation(
      bookingCodeForPublish,
      tickets,
      ticketOwnerUserId
    );

    if (changedZoneId) {
      await this.emitZoneTicketUpdate(changedZoneId);
    }

    if (!shouldSendConfirmation) {
      return;
    }

    const ticketMailData = tickets.map((ticket) => ({
      ticketCode: ticket.ticketCode,
      seatNumber: ticket.seatNumber,
      qrCode: ticket.qrCode || "",
    }));

    try {
      this.userEventsService.emitSendBookingConfirmation({
        email: confirmedBooking.customerEmail,
        customerName: confirmedBooking.customerName || "Khách hàng",
        bookingCode: confirmedBooking.bookingCode,
        eventTitle: confirmedBooking.eventId.title,
        eventLocation: confirmedBooking.eventId.location,
        eventDate: confirmedBooking.eventId.startDate,
        zoneName: confirmedBooking.zoneId.name,
        seats: confirmedBooking.seats || [],
        quantity: confirmedBooking.quantity,
        totalPrice: confirmedBooking.totalPrice,
        currency: payment.currency,
        tickets: ticketMailData,
      });
    } catch (emailError) {
      this.logger.warn(
        `Failed to send PayPal confirmation email for booking ${confirmedBooking.bookingCode}: ${(emailError as Error)?.message || "unknown error"}`
      );
    }
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

  async handlePaymentCancelled(userId: string, bookingCode: string) {
    const dbSession = await this.bookingModel.db.startSession();
    let cancelled = false;
    let changedZoneId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const booking = await this.bookingModel
          .findOne({
            bookingCode,
            userId: new Types.ObjectId(userId),
            status: "pending",
            paymentStatus: "unpaid",
            isDeleted: false,
          })
          .session(dbSession);

        if (!booking) {
          return;
        }

        booking.status = BookingStatus.CANCELLED;
        booking.cancellationReason = "Payment cancelled by user";
        await booking.save({ session: dbSession });

        await this.zoneModel.findByIdAndUpdate(
          booking.zoneId,
          { $inc: { soldCount: -booking.quantity } },
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
}
