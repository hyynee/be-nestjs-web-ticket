import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import config from "@src/config/config";
import {
  CHECKOUT_DEDUP_SCRIPT,
  STRIPE_MIN_EXPIRES_IN_MS,
} from "@src/payment/payment.constants";
import { PaymentGatewayService } from "@src/payment/infrastructure/gateway/payment-gateway.service";
import { PaymentPresenter } from "@src/payment/presenters/payment.presenter";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import { toPaymentObjectId } from "@src/payment/domain/utils/payment-document.utils";
import type {
  BookingEventSummary,
  BookingZoneSummary,
  CheckoutSessionResult,
} from "@src/payment/types/payment.types";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { RedisService } from "@src/redis/redis.service";
import { Model, Types } from "mongoose";
import Stripe from "stripe";

@Injectable()
export class CreateCheckoutSessionUseCase {
  private readonly logger = new Logger(CreateCheckoutSessionUseCase.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly redisService: RedisService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentPresenter: PaymentPresenter
  ) {}

  async execute(
    userId: string,
    bookingCode: string
  ): Promise<CheckoutSessionResult> {
    const booking = await this.bookingModel
      .findOne({
        bookingCode,
        userId: new Types.ObjectId(userId),
        isDeleted: false,
      })
      .populate<{ eventId: BookingEventSummary }>(
        "eventId",
        "title thumbnail location startDate endDate"
      )
      .populate<{ zoneId: BookingZoneSummary }>("zoneId", "name price")
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

    if (booking.expiresAt.getTime() - Date.now() < STRIPE_MIN_EXPIRES_IN_MS) {
      throw new BadRequestException(
        "Thời gian giữ chỗ sắp hết hạn, vui lòng đặt lại vé để thanh toán"
      );
    }

    const event = booking.eventId;
    const zone = booking.zoneId;
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
      CHECKOUT_DEDUP_SCRIPT,
      { keys: [dedupKey, dedupLockKey], arguments: [] }
    )) as string[];

    const luaStatus = luaResult[0];
    const luaValue = luaResult[1];

    if (luaStatus === "existing" && luaValue) {
      try {
        const existingSession =
          await this.paymentGateway.stripe.checkout.sessions.retrieve(luaValue);
        if (existingSession.status === "open") {
          return this.paymentPresenter.checkoutSessionResult(
            "Checkout session already exists",
            existingSession.url
          );
        }
      } catch (error) {
        this.logger.warn(
          `CreateCheckoutSessionUseCase: existing Stripe session lookup failed for bookingCode=${booking.bookingCode}; creating a fresh checkout session: ${getPaymentErrorMessage(error)}`
        );
      }
    }

    if (luaStatus === "conflict") {
      throw new ConflictException(
        "Checkout session creation already in progress — please wait a moment and retry"
      );
    }

    const productName = booking.snapshot
      ? `${booking.snapshot.eventTitle} - ${booking.snapshot.zoneName}`
      : `${event.title} - ${zone.name}`;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = [
      {
        price_data: {
          currency: "vnd",
          product_data: {
            name: productName,
            description:
              booking.seats.length > 0
                ? `Ghế: ${booking.seats.join(", ")}`
                : `Số lượng: ${booking.quantity} vé`,
            images: [thumbnailUrl],
            metadata: {
              eventId: toPaymentObjectId(event._id, "eventId").toString(),
              zoneId: toPaymentObjectId(zone._id, "zoneId").toString(),
            },
          },
          unit_amount: Math.round(booking.pricePerTicket),
        },
        quantity: booking.seats.length || booking.quantity,
      },
    ];

    const session = await this.paymentGateway.stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      customer_email: booking.customerEmail,
      line_items: lineItems,
      phone_number_collection: { enabled: true },
      success_url: `${config.FRONTEND_URL}/my-bookings`,
      cancel_url: `${config.FRONTEND_URL}/booking/cancel?booking_code=${booking.bookingCode}`,
      metadata: {
        userId,
        bookingCode: booking.bookingCode,
        bookingId: booking._id.toString(),
      },
      expires_at: Math.floor(booking.expiresAt.getTime() / 1000),
    });

    await this.redisService.client.set(dedupKey, session.id, {
      EX: ttlSeconds,
    });
    await this.redisService.client.del(dedupLockKey).catch((error: unknown) => {
      this.logger.warn(
        `checkout dedup lock release failed for booking ${booking.bookingCode}: ${getPaymentErrorMessage(error)}`
      );
    });

    return this.paymentPresenter.checkoutSessionResult(
      "Checkout session created successfully",
      session.url
    );
  }
}
