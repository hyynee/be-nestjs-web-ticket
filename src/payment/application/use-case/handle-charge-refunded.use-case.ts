import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { HOT_EVENTS_CACHE_KEY } from "@src/payment/payment.constants";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Zone } from "@src/schemas/zone.schema";
import { RedisService } from "@src/redis/redis.service";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { Model, Types } from "mongoose";
import Stripe from "stripe";

@Injectable()
export class HandleChargeRefundedUseCase {
  private readonly logger = new Logger(HandleChargeRefundedUseCase.name);

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly redisService: RedisService,
    private readonly zoneGateway: ZoneGateway
  ) {}

  async execute(charge: Stripe.Charge): Promise<void> {
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
          return;
        }

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
                    $max: [{ $subtract: ["$soldCount", booking.quantity] }, 0],
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
      });
    } finally {
      await dbSession.endSession();
    }

    if (changedZoneId) {
      await this.emitZoneTicketUpdate(changedZoneId);
    }

    await this.redisService.client
      .del(HOT_EVENTS_CACHE_KEY)
      .catch((error: unknown) => {
        this.logger.warn(
          `hot-events cache invalidation failed after charge refund ${charge.id}: ${getPaymentErrorMessage(error)}`
        );
      });
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

  private async emitZoneTicketUpdate(
    zoneId: Types.ObjectId | string
  ): Promise<void> {
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
}
