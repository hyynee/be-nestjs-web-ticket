import { Injectable, BadRequestException, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
  SeatLock,
} from "@src/schemas/booking.schema";
import { SeatState } from "@src/schemas/seat-state.schema";

import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Model, Types } from "mongoose";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { CancelBookingDto } from "../../dto/cancel-booking.dto";
import { ZoneService } from "@src/zone/zone.service";
import { RedisService } from "@src/redis/redis.service";
import { SLOT_SOLD_KEY_PREFIX } from "../../booking.constants";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { UploadService } from "@src/upload/upload.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { BookingMessageResult } from "../../domain/types/booking-response.types";
import { BookingCacheService } from "../../infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "../../infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "../../presenters/booking.presenter";
import { BookingCodeService } from "../../domain/services/booking-code.service";

@Injectable()
export class CancelBookingUseCase {
  private readonly logger = new Logger(CancelBookingUseCase.name);

  constructor(
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(SeatLock.name) private seatLockModel: Model<SeatLock>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @InjectModel(Area.name) private areaModel: Model<Area>,
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Payment.name) private paymentModel: Model<Payment>,
    @InjectModel(SeatState.name) private seatStateModel: Model<SeatState>,
    private readonly zoneService: ZoneService,
    private readonly redisService: RedisService,
    private readonly paymentService: PaymentService,
    private readonly metricsService: MetricsService,
    private readonly auditService: AuditService,
    private readonly uploadService: UploadService,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly bookingCacheService: BookingCacheService,
    private readonly bookingZoneNotifier: BookingZoneNotifierService,
    private readonly bookingPresenter: BookingPresenter,
    private readonly bookingCodeService: BookingCodeService
  ) {}

  async cancelBooking(
    userId: string,
    dto: CancelBookingDto
  ): Promise<BookingMessageResult> {
    const session = await this.bookingModel.db.startSession();
    const { bookingCode } = dto;
    let changedZoneId: Types.ObjectId | null = null;
    let changedEventKey: string | undefined;
    let changedZoneKey: string | undefined;
    let cancelledTimeSlotId: Types.ObjectId | undefined;
    let cancelledQuantity = 0;

    try {
      await session.withTransaction(async () => {
        const booking = await this.bookingModel.findOneAndUpdate(
          {
            bookingCode,
            userId: new Types.ObjectId(userId),
            status: BookingStatus.PENDING,
            paymentStatus: PaymentStatus.UNPAID,
            isDeleted: false,
          },
          {
            $set: {
              status: BookingStatus.CANCELLED,
              cancelledAt: new Date(),
              cancelledBy: new Types.ObjectId(userId),
            },
          },
          { new: true, session }
        );

        if (!booking) {
          throw new BadRequestException(
            "Booking not found, already cancelled/confirmed, or does not belong to this user"
          );
        }

        if (booking.timeSlotId) {
          cancelledTimeSlotId = booking.timeSlotId as Types.ObjectId;
          cancelledQuantity = booking.quantity;
        }

        await this.ticketModel.updateMany(
          {
            bookingId: booking._id,
            status: "valid",
            isDeleted: false,
          },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date(),
              cancelledBy: new Types.ObjectId(userId),
            },
          },
          { session }
        );

        await this.seatLockModel.deleteMany(
          { bookingId: booking._id },
          { session }
        );

        await this.zoneModel.updateOne(
          { _id: booking.zoneId },
          [
            {
              $set: {
                soldCount: {
                  $max: [{ $subtract: ["$soldCount", booking.quantity] }, 0],
                },
              },
            },
          ],
          { session }
        );
        changedZoneId = booking.zoneId as Types.ObjectId;
        changedEventKey = booking.eventId?.toString();
        changedZoneKey = booking.zoneId?.toString();

        this.logger.log(
          `cancelBooking: bookingCode=${bookingCode}, userId=${userId}, zoneId=${booking.zoneId}`
        );
      });

      if (cancelledTimeSlotId) {
        await this.redisService.client
          .decrBy(
            `${SLOT_SOLD_KEY_PREFIX}${cancelledTimeSlotId}`,
            cancelledQuantity
          )
          .catch(() => {});
      }

      await Promise.all([
        this.bookingCacheService.invalidateBookingCache(
          changedEventKey,
          changedZoneKey
        ),
        this.bookingCacheService.invalidateUserBookingCache(userId),
        changedZoneId
          ? this.zoneService.invalidateZoneAvailabilityCache(changedZoneId)
          : Promise.resolve(),
      ]);

      if (changedZoneId) {
        await this.bookingZoneNotifier.emitZoneTicketUpdate(changedZoneId);
      }

      return this.bookingPresenter.bookingMessage(
        "Booking cancelled successfully"
      );
    } catch (error) {
      this.logger.error(
        `cancelBooking: failed — bookingCode=${bookingCode}, userId=${userId}, error=${(error as Error)?.message}`
      );
      throw error;
    } finally {
      session.endSession();
    }
  }
}
