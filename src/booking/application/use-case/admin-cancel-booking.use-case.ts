import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
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
import { ZoneService } from "@src/zone/zone.service";
import { RedisService } from "@src/redis/redis.service";
import { SLOT_SOLD_KEY_PREFIX } from "../../booking.constants";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { UploadService } from "@src/upload/upload.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { BookingMessageResult } from "../../domain/types/booking-response.types";
import { BookingCacheService } from "../../infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "../../infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "../../presenters/booking.presenter";
import { BookingCodeService } from "../../domain/services/booking-code.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";

@Injectable()
export class AdminCancelBookingUseCase {
  private readonly logger = new Logger(AdminCancelBookingUseCase.name);

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

  private assertObjectId(value: string, label: string): void {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
  }

  async adminCancelBooking(
    bookingId: string,
    adminId: string,
    reason?: string
  ): Promise<BookingMessageResult> {
    this.assertObjectId(bookingId, "booking ID");
    const session = await this.bookingModel.db.startSession();
    let changedZoneId: Types.ObjectId | null = null;
    let changedEventKey: string | undefined;
    let changedZoneKey: string | undefined;
    let bookedUserId: string | null = null;
    let capturedStripePaymentIntentId: string | undefined;
    let wasConfirmedAndPaid = false;
    let cancelledTicketCodes: string[] = [];
    let adminCancelledSlotId: Types.ObjectId | undefined;
    let adminCancelledQuantity = 0;

    try {
      await session.withTransaction(async () => {
        const preUpdate = await this.bookingModel.findOneAndUpdate(
          {
            _id: new Types.ObjectId(bookingId),
            isDeleted: false,
            status: { $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED] },
          },
          [
            {
              $set: {
                status: BookingStatus.CANCELLED,
                cancelledAt: new Date(),
                cancelledBy: new Types.ObjectId(adminId),
                cancellationReason: reason ?? "Cancelled by admin",
                paymentStatus: {
                  $cond: {
                    if: {
                      $and: [
                        { $eq: ["$status", BookingStatus.CONFIRMED] },
                        { $eq: ["$paymentStatus", PaymentStatus.PAID] },
                      ],
                    },
                    then: PaymentStatus.REFUND_PENDING,
                    else: "$paymentStatus",
                  },
                },
              },
            },
          ],
          { new: false, session }
        );

        if (!preUpdate) {
          throw new NotFoundException(
            "Booking not found or already cancelled/expired"
          );
        }

        bookedUserId = preUpdate.userId.toString();
        wasConfirmedAndPaid =
          preUpdate.status === BookingStatus.CONFIRMED &&
          preUpdate.paymentStatus === PaymentStatus.PAID;
        capturedStripePaymentIntentId = preUpdate.stripePaymentIntentId;

        if (preUpdate.timeSlotId) {
          adminCancelledSlotId = preUpdate.timeSlotId as Types.ObjectId;
          adminCancelledQuantity = preUpdate.quantity;
        }

        const ticketsToCancel = await this.ticketModel
          .find({ bookingId: preUpdate._id, status: "valid", isDeleted: false })
          .select("ticketCode")
          .session(session)
          .lean();
        cancelledTicketCodes = ticketsToCancel.map((t) => t.ticketCode);

        await this.ticketModel.updateMany(
          { bookingId: preUpdate._id, status: "valid", isDeleted: false },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date(),
              cancelledBy: new Types.ObjectId(adminId),
            },
          },
          { session }
        );

        // Release seat locks immediately so seats are available for rebooking
        await this.seatLockModel.deleteMany(
          { bookingId: preUpdate._id },
          { session }
        );

        if (preUpdate.quantity > 0) {
          await this.zoneModel.updateOne(
            { _id: preUpdate.zoneId },
            [
              {
                $set: {
                  soldCount: {
                    $max: [
                      { $subtract: ["$soldCount", preUpdate.quantity] },
                      0,
                    ],
                  },
                },
              },
            ],
            { session }
          );

          if (wasConfirmedAndPaid) {
            await this.zoneModel.updateOne(
              { _id: preUpdate.zoneId },
              [
                {
                  $set: {
                    confirmedSoldCount: {
                      $max: [
                        {
                          $subtract: [
                            "$confirmedSoldCount",
                            preUpdate.quantity,
                          ],
                        },
                        0,
                      ],
                    },
                  },
                },
              ],
              { session }
            );
          }
        }

        changedZoneId = preUpdate.zoneId as Types.ObjectId;
        changedEventKey = preUpdate.eventId?.toString();
        changedZoneKey = preUpdate.zoneId?.toString();

        this.logger.log(
          `adminCancelBooking: bookingId=${bookingId}, adminId=${adminId}, wasConfirmedAndPaid=${wasConfirmedAndPaid}, reason="${reason}"`
        );
      });

      // Post-commit: giải phóng slot capacity
      if (adminCancelledSlotId) {
        await this.redisService.client
          .decrBy(
            `${SLOT_SOLD_KEY_PREFIX}${adminCancelledSlotId}`,
            adminCancelledQuantity
          )
          .catch((error: unknown) => {
            this.logger.warn(
              `adminCancelBooking: failed to release slot counter slotId=${adminCancelledSlotId}, quantity=${adminCancelledQuantity}: ${getErrorMessage(error)}`
            );
          });
      }

      await Promise.all([
        this.bookingCacheService.invalidateBookingCache(
          changedEventKey,
          changedZoneKey
        ),
        bookedUserId
          ? this.bookingCacheService.invalidateUserBookingCache(bookedUserId)
          : Promise.resolve(),
        changedZoneId
          ? this.zoneService.invalidateZoneAvailabilityCache(changedZoneId)
          : Promise.resolve(),
      ]);

      if (changedZoneId) {
        await this.bookingZoneNotifier.emitZoneTicketUpdate(changedZoneId);
      }

      if (cancelledTicketCodes.length > 0) {
        Promise.all(
          cancelledTicketCodes.map((code) =>
            this.uploadService
              .deleteQRCode(code)
              .catch((err: unknown) =>
                this.logger.warn(
                  `adminCancelBooking: QR cleanup failed for ${code}: ${getErrorMessage(err)}`
                )
              )
          )
        ).catch((error: unknown) => {
          this.logger.warn(
            `adminCancelBooking: QR cleanup batch failed for bookingId=${bookingId}: ${getErrorMessage(error)}`
          );
        });
      }

      if (wasConfirmedAndPaid) {
        await this.paymentService.issueAdminRefund(
          bookingId,
          capturedStripePaymentIntentId,
          adminId,
          reason ?? "Admin cancellation"
        );
      }

      try {
        await this.auditService.record({
          action: AuditAction.BOOKING_ADMIN_CANCEL,
          actorId: adminId,
          actorRole: "admin",
          bookingId,
          reason: reason ?? "Admin cancellation",
          metadata: { wasConfirmedAndPaid },
        });
      } catch (auditErr) {
        this.logger.error(
          `adminCancelBooking: audit record FAILED for bookingId=${bookingId} — ${(auditErr as Error)?.message}. MANUAL AUDIT REQUIRED.`
        );
      }

      return this.bookingPresenter.bookingMessage("Booking cancelled by admin");
    } catch (error) {
      this.logger.error(
        `adminCancelBooking: failed — bookingId=${bookingId}, adminId=${adminId}, error=${(error as Error)?.message}`
      );
      throw error;
    } finally {
      session.endSession();
    }
  }
}
