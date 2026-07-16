import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { PaymentGatewayService } from "@src/payment/infrastructure/gateway/payment-gateway.service";
import { PaymentConfirmationDeliveryService } from "@src/payment/application/services/payment-confirmation-delivery.service";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import { toPaymentObjectId } from "@src/payment/domain/utils/payment-document.utils";
import type {
  BookingForConfirmationMail,
  CreatedTicketForMail,
} from "@src/payment/types/payment.types";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Zone } from "@src/schemas/zone.schema";
import { TicketService } from "@src/ticket/ticket.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { Model, Types } from "mongoose";
import Stripe from "stripe";

@Injectable()
export class StripePaymentSettlementService {
  private readonly logger = new Logger(StripePaymentSettlementService.name);

  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly ticketService: TicketService,
    private readonly metricsService: MetricsService,
    private readonly paymentGateway: PaymentGatewayService,
    private readonly deliveryService: PaymentConfirmationDeliveryService
  ) {}

  async handleCheckoutSessionCompleted(
    session: Stripe.Checkout.Session
  ): Promise<void> {
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
                "zoneId quantity bookingCode areaId eventId seats customerEmail customerName totalPrice userId snapshot",
              session: dbSession,
            }
          )
          .populate<{ eventId: BookingForConfirmationMail["eventId"] }>(
            "eventId",
            "title location startDate endDate"
          )
          .populate<{ zoneId: BookingForConfirmationMail["zoneId"] }>(
            "zoneId",
            "name"
          )
          .populate("areaId", "name");

        let booking = updatedBooking;

        if (!booking) {
          booking = await this.bookingModel
            .findOne({ _id: bookingId, bookingCode, isDeleted: false })
            .select(
              "zoneId quantity bookingCode areaId eventId seats customerEmail customerName totalPrice userId snapshot status paymentStatus"
            )
            .session(dbSession)
            .populate<{ eventId: BookingForConfirmationMail["eventId"] }>(
              "eventId",
              "title location startDate endDate"
            )
            .populate<{ zoneId: BookingForConfirmationMail["zoneId"] }>(
              "zoneId",
              "name"
            )
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
            changedZoneId = toPaymentObjectId(booking.zoneId, "zoneId");
          }
        }

        let rawEventId: Types.ObjectId;
        if (booking.eventId) {
          rawEventId = toPaymentObjectId(booking.eventId, "eventId");
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
        bookingForMail =
          this.deliveryService.toBookingConfirmationMail(booking);
        ticketOwnerUserId = booking.userId?.toString();
      });
    } catch (error) {
      this.logger.error(
        `Error handling checkout session ${session.id}: ${getPaymentErrorMessage(error)}`
      );
      throw error;
    } finally {
      await dbSession.endSession();
    }

    if (shouldRefund && paymentIntentForRefund) {
      await this.autoRefundCapturedStripePayment(
        paymentIntentForRefund,
        bookingId
      );
      return;
    }

    if (!bookingForMail || tickets.length === 0) {
      return;
    }

    const confirmedBooking = bookingForMail as BookingForConfirmationMail;
    const bookingCodeForPublish = confirmedBooking.bookingCode;

    await this.deliveryService.publishTicketCreation(
      confirmedBooking,
      bookingCodeForPublish,
      tickets,
      ticketOwnerUserId,
      "payment confirmed"
    );

    if (changedZoneId) {
      await this.deliveryService.emitZoneTicketUpdateSafely(
        changedZoneId,
        `stripe, booking=${bookingCodeForPublish}`
      );
    }

    this.metricsService.paymentsTotal.inc({
      provider: "stripe",
      status: "succeeded",
    });
    await this.deliveryService.invalidateHotEventsCache(
      `stripe, booking=${bookingCodeForPublish}`
    );

    if (!shouldSendConfirmation) {
      return;
    }

    const confirmationPayload =
      this.deliveryService.buildBookingConfirmationPayload(
        confirmedBooking,
        session.currency || "vnd",
        session.amount_total || confirmedBooking.totalPrice || 0,
        session.customer_details?.email,
        session.customer_details?.name
      );

    tickets = await this.deliveryService.finalizeTicketsForDelivery(
      bookingCodeForPublish,
      tickets,
      confirmationPayload
    );

    await this.deliveryService.enqueueConfirmationSafely(
      confirmedBooking.bookingCode,
      "Stripe",
      confirmationPayload,
      tickets
    );
  }

  private async autoRefundCapturedStripePayment(
    paymentIntentForRefund: string,
    bookingId: string
  ): Promise<void> {
    this.metricsService.paymentsTotal.inc({
      provider: "stripe",
      status: "auto_refunded",
    });
    this.logger.error(
      `[MONEY_RISK] Stripe captured ${paymentIntentForRefund} but booking ${bookingId} is in non-payable state. Initiating auto-refund.`
    );
    try {
      await this.paymentGateway.stripe.refunds.create({
        payment_intent: paymentIntentForRefund,
        metadata: {
          reason: "booking_cancelled_before_confirmation",
          bookingId,
        },
      });
      this.logger.warn(
        `[AUTO_REFUND] Refund issued for payment_intent=${paymentIntentForRefund}, bookingId=${bookingId}`
      );
    } catch (error) {
      this.logger.error(
        `[CRITICAL] Auto-refund FAILED for payment_intent=${paymentIntentForRefund}. MANUAL REFUND REQUIRED. Error: ${getPaymentErrorMessage(error)}`
      );
    }
  }
}
