import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Zone } from "@src/schemas/zone.schema";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { ZoneService } from "@src/zone/zone.service";
import { PromotionService } from "@src/promotion/promotion.service";
import { Model, Types } from "mongoose";
import type { PaymentCancelResult } from "@src/payment/types/payment.types";
import { PaymentPresenter } from "@src/payment/presenters/payment.presenter";

@Injectable()
export class CancelPaymentUseCase {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly zoneGateway: ZoneGateway,
    private readonly zoneService: ZoneService,
    private readonly promotionService: PromotionService,
    private readonly paymentPresenter: PaymentPresenter
  ) {}

  async execute(
    userId: string,
    bookingCode: string
  ): Promise<PaymentCancelResult | void> {
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

        // HIGH fix: promo quota leak — this is the only PENDING/UNPAID
        // cancellation path that was missing this call (cancel-booking.use-
        // case.ts and admin-cancel-booking.use-case.ts already release usage
        // for the equivalent pending/unpaid case). Same session as the
        // booking cancel/zone decrement above: if release throws, the whole
        // transaction aborts — booking must never end up CANCELLED with the
        // promo usage/quota left dangling (rule.md 3.1/12: no read-then-write
        // outside the atomic boundary, no partial commit).
        await this.promotionService.releaseUsageForBooking(
          booking._id as Types.ObjectId,
          dbSession
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
      await this.zoneService.invalidateZoneAvailabilityCache(changedZoneId);
      await this.emitZoneTicketUpdate(changedZoneId);
    }

    return this.paymentPresenter.paymentCancelResult(
      "Payment cancelled successfully"
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
