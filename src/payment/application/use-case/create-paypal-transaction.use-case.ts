import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import config from "@src/config/config";
import {
  PaymentGatewayService,
  paypalSdk,
} from "@src/payment/infrastructure/gateway/payment-gateway.service";
import { PaymentPresenter } from "@src/payment/presenters/payment.presenter";
import { toPaymentObjectId } from "@src/payment/domain/utils/payment-document.utils";
import type {
  BookingEventSummary,
  PaypalCreateTransactionResult,
  PaypalOrderCreateResponse,
} from "@src/payment/types/payment.types";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { CurrencyService } from "@src/currency/currency.service";
import { Model, Types } from "mongoose";

@Injectable()
export class CreatePaypalTransactionUseCase {
  private readonly logger = new Logger(CreatePaypalTransactionUseCase.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    private readonly currencyService: CurrencyService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly paymentPresenter: PaymentPresenter
  ) {}

  async execute(
    userId: string,
    bookingCode: string
  ): Promise<PaypalCreateTransactionResult> {
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

    const event = booking.eventId;
    const eventTitle = booking.snapshot?.eventTitle ?? event.title;

    const vndPerUsd = await this.currencyService.getVndPerUsd();
    const amountUSD = (booking.totalPrice / vndPerUsd).toFixed(2);
    if (parseFloat(amountUSD) < 0.01) {
      throw new BadRequestException(
        "Giá trị booking quá nhỏ để xử lý qua PayPal (tối thiểu ~230 VND)"
      );
    }

    const request = new paypalSdk.orders.OrdersCreateRequest();
    request.prefer("return=representation");

    request.requestBody({
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: booking.bookingCode,
          description: `Ticket for ${eventTitle}`,
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
      expiry_time: booking.expiresAt.toISOString(),
    });

    try {
      const response = await this.paymentGateway.withPaypalTimeout(
        this.paymentGateway.paypalClient.execute<PaypalOrderCreateResponse>(
          request
        )
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
            metadata: { bookingCode, eventTitle, amountUSD },
          },
          $setOnInsert: {
            eventId: toPaymentObjectId(booking.eventId, "eventId"),
            amount: booking.totalPrice,
            currency: "VND",
            status: "pending",
            paymentMethod: "paypal",
          },
        },
        { upsert: true, new: true }
      );

      const approveLink = order.links.find((link) => link.rel === "approve");
      return this.paymentPresenter.paypalCreateTransactionResult({
        paypalOrderId: order.id,
        approvalUrl: approveLink?.href,
        amountUSD,
        bookingCode: booking.bookingCode,
        amount: booking.totalPrice,
        customerEmail: booking.customerEmail,
        customerName: booking.customerName,
        customerPhone: booking.customerPhone,
      });
    } catch (error) {
      this.logger.error(
        `PayPal order creation failed for booking ${bookingCode}: ${(error as Error)?.message || "unknown error"}`
      );
      throw new BadRequestException("Failed to create PayPal order");
    }
  }
}
