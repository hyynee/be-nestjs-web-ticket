import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Booking, BookingStatus, SeatLock } from "@src/schemas/booking.schema";

import { Zone } from "@src/schemas/zone.schema";
import { Model, Types } from "mongoose";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { ZoneService } from "@src/zone/zone.service";
import { EXPIRE_BATCH_SIZE, SLOT_SOLD_KEY_PREFIX } from "../booking.constants";
import { ExpirePendingBookingsResult } from "../domain/types/booking-response.types";
import { BookingCacheService } from "../infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "../infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "../presenters/booking.presenter";

@Injectable()
export class BookingMaintenanceService {
  private readonly logger = new Logger(BookingMaintenanceService.name);

  constructor(
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(SeatLock.name) private seatLockModel: Model<SeatLock>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Payment.name) private paymentModel: Model<Payment>,
    private readonly zoneService: ZoneService,
    private readonly bookingCacheService: BookingCacheService,
    private readonly bookingZoneNotifier: BookingZoneNotifierService,
    private readonly bookingPresenter: BookingPresenter
  ) {}

  async expirePendingBookings(): Promise<ExpirePendingBookingsResult> {
    const session = await this.bookingModel.db.startSession();
    let committedZoneIds = new Set<string>();
    let committedSlotTotals = new Map<string, number>();
    try {
      const result = await session.withTransaction(async () => {
        committedZoneIds = new Set<string>();
        committedSlotTotals = new Map<string, number>();
        const now = new Date();

        const candidates = await this.bookingModel
          .find(
            {
              status: BookingStatus.PENDING,
              expiresAt: { $lt: now },
              isDeleted: false,
            },
            { _id: 1, zoneId: 1, quantity: 1 }
          )
          .session(session)
          .limit(EXPIRE_BATCH_SIZE)
          .lean();

        if (!candidates.length) {
          return this.bookingPresenter.expireResult(
            "Không có booking hết hạn",
            0
          );
        }

        const zoneTotals = new Map<string, number>();

        const ids = candidates.map((c) => c._id);
        const { modifiedCount: expired } = await this.bookingModel.updateMany(
          {
            _id: { $in: ids },
            status: BookingStatus.PENDING,
            isDeleted: false,
          },
          { $set: { status: BookingStatus.EXPIRED } },
          { session }
        );

        if (!expired) {
          return this.bookingPresenter.expireResult(
            "Không có booking hết hạn",
            0
          );
        }

        const actuallyExpiredDocs = await this.bookingModel
          .find(
            { _id: { $in: ids }, status: BookingStatus.EXPIRED },
            { zoneId: 1, quantity: 1, timeSlotId: 1 }
          )
          .session(session)
          .lean();

        for (const doc of actuallyExpiredDocs) {
          const key = (doc.zoneId as Types.ObjectId).toString();
          zoneTotals.set(
            key,
            (zoneTotals.get(key) ?? 0) + (doc.quantity as number)
          );
        }

        if (!zoneTotals.size) {
          return this.bookingPresenter.expireResult(
            "Không có booking hết hạn",
            0
          );
        }

        await this.seatLockModel.deleteMany(
          { bookingId: { $in: actuallyExpiredDocs.map((d) => d._id) } },
          { session }
        );

        await this.zoneModel.bulkWrite(
          [...zoneTotals.entries()].map(([zoneId, totalQuantity]) => ({
            updateOne: {
              filter: { _id: new Types.ObjectId(zoneId) },
              update: [
                {
                  $set: {
                    soldCount: {
                      $max: [{ $subtract: ["$soldCount", totalQuantity] }, 0],
                    },
                  },
                },
              ],
            },
          })),
          { session }
        );

        for (const zoneId of zoneTotals.keys()) {
          committedZoneIds.add(zoneId);
        }

        for (const doc of actuallyExpiredDocs) {
          if (doc.timeSlotId) {
            const sk = (doc.timeSlotId as Types.ObjectId).toString();
            committedSlotTotals.set(
              sk,
              (committedSlotTotals.get(sk) ?? 0) + (doc.quantity as number)
            );
          }
        }

        return this.bookingPresenter.expireResult(
          `Đã expire ${expired} booking`,
          expired
        );
      });

      await this.bookingCacheService.invalidateBookingCache();
      if (committedZoneIds.size > 0) {
        await Promise.all(
          [...committedZoneIds].map((zoneId) =>
            this.zoneService.invalidateZoneAvailabilityCache(zoneId)
          )
        );
      }
      if (committedSlotTotals.size > 0) {
        await Promise.all(
          [...committedSlotTotals.entries()].map(([slotId, qty]) =>
            this.bookingCacheService.client
              .decrBy(`${SLOT_SOLD_KEY_PREFIX}${slotId}`, qty)
              .catch(() => {})
          )
        );
      }
      for (const zoneId of committedZoneIds) {
        await this.bookingZoneNotifier.emitZoneTicketUpdate(zoneId);
      }

      this.logger.log(`expirePendingBookings: ${JSON.stringify(result)}`);
      return result;
    } catch (error) {
      this.logger.error(
        `expirePendingBookings: failed — error=${(error as Error)?.message}`
      );
      throw error;
    } finally {
      session.endSession();
    }
  }

  async cleanupOldBookings(before: Date): Promise<void> {
    const session = await this.bookingModel.db.startSession();
    try {
      await session.withTransaction(async () => {
        const cutoffFilter = {
          status: { $in: [BookingStatus.EXPIRED, BookingStatus.CANCELLED] },
          updatedAt: { $lt: before },
          isDeleted: false,
        };

        const toSoftDelete = await this.bookingModel
          .find(cutoffFilter, { _id: 1 })
          .session(session)
          .lean();
        const ids = (toSoftDelete as Array<{ _id: Types.ObjectId }>).map(
          (b) => b._id
        );

        if (!ids.length) {
          this.logger.log("cleanupOldBookings: No old bookings to clean up.");
          return;
        }

        const { modifiedCount: bookingCount } =
          await this.bookingModel.updateMany(
            { _id: { $in: ids } },
            { $set: { isDeleted: true } },
            { session }
          );

        if (!bookingCount) {
          this.logger.log("cleanupOldBookings: No old bookings to clean up.");
          return;
        }

        const [{ modifiedCount: ticketCount }] = await Promise.all([
          this.ticketModel.updateMany(
            { bookingId: { $in: ids }, isDeleted: false },
            { $set: { isDeleted: true } },
            { session }
          ),
          this.paymentModel.updateMany(
            { bookingId: { $in: ids }, isDeleted: false },
            { $set: { isDeleted: true } },
            { session }
          ),
        ]);

        this.logger.log(
          `cleanupOldBookings: Soft-deleted ${bookingCount} bookings, ${ticketCount} related tickets and payment records.`
        );
      });
    } catch (error) {
      this.logger.error(
        `cleanupOldBookings: Failed during database transaction — error=${error instanceof Error ? error.message : "unknown"}`
      );
      throw error;
    } finally {
      await session.endSession();
    }
  }
}
