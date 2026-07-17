import * as crypto from "crypto";
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

import { Event, EventStatus } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Model, Types } from "mongoose";
import { CreateBookingDto } from "../../dto/create-booking.dto";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { ZoneService } from "@src/zone/zone.service";
import { RedisService } from "@src/redis/redis.service";
import {
  BOOKING_EXPIRY_MS,
  MAX_TICKETS_PER_USER_PER_EVENT,
  SLOT_COUNTER_TTL_BUFFER_SEC,
  SLOT_SOLD_KEY_PREFIX,
} from "../../booking.constants";
import { isDuplicateKeyError } from "@src/common/utils/mongo.utils";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { UploadService } from "@src/upload/upload.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { BookingCreatePayload, SlotCapacityInfo } from "../../booking.types";
import { BookingCreateResult } from "../../domain/types/booking-response.types";
import { BookingCacheService } from "../../infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "../../infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "../../presenters/booking.presenter";
import { BookingCodeService } from "../../domain/services/booking-code.service";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import { NotificationService } from "@src/notification/notification.service";
import { PromotionService } from "@src/promotion/promotion.service";

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class CreateBookingUseCase {
  private readonly logger = new Logger(CreateBookingUseCase.name);

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
    private readonly bookingCodeService: BookingCodeService,
    private readonly notificationService: NotificationService,
    private readonly promotionService: PromotionService
  ) {}

  async createBooking(
    userId: string,
    data: CreateBookingDto
  ): Promise<BookingCreateResult> {
    const userEventLockKey = `booking:user-limit:${userId}:${data.eventId}`;
    const userEventLockValue = crypto.randomBytes(16).toString("hex");
    const lockAcquired = await this.redisService.client.set(
      userEventLockKey,
      userEventLockValue,
      { NX: true, EX: 30 }
    );
    if (!lockAcquired) {
      throw new BadRequestException(
        "Đang có yêu cầu đặt vé khác đang xử lý. Vui lòng thử lại sau giây lát."
      );
    }

    const session = await this.bookingModel.db.startSession();
    let changedZoneId: Types.ObjectId | null = null;
    let slotCapacity: SlotCapacityInfo | null = null;
    let slotCapacityReserved = false;
    let bookingCommitted = false;

    try {
      if (data.timeSlotId) {
        const eventForSlot = await this.eventModel
          .findById(data.eventId)
          .select("timeSlots endDate")
          .lean();
        const targetSlot = eventForSlot?.timeSlots?.find(
          (s) => s._id.toString() === data.timeSlotId
        );
        if (typeof targetSlot?.capacity === "number") {
          const counterKey = `${SLOT_SOLD_KEY_PREFIX}${data.timeSlotId}`;
          const newCount = await this.redisService.client.incrBy(
            counterKey,
            data.quantity
          );
          const ttlSec = Math.max(
            3600,
            Math.ceil(
              ((eventForSlot?.endDate?.getTime() ?? Date.now()) - Date.now()) /
                1000
            ) + SLOT_COUNTER_TTL_BUFFER_SEC
          );
          await this.redisService.client
            .expire(counterKey, ttlSec)
            .catch((error: unknown) => {
              this.logger.warn(
                `createBooking: failed to set slot counter TTL counterKey=${counterKey}: ${getErrorMessage(error)}`
              );
            });
          if (newCount > targetSlot.capacity) {
            await this.redisService.client.decrBy(counterKey, data.quantity);
            throw new BadRequestException(
              `Khung giờ "${targetSlot.label}" đã hết chỗ (tối đa ${targetSlot.capacity} vé)`
            );
          }
          slotCapacity = {
            label: targetSlot.label,
            capacity: targetSlot.capacity,
            counterKey,
          };
          slotCapacityReserved = true;
        }
      }

      let result: BookingCreateResult | undefined;
      await session.withTransaction(async () => {
        const event = await this.eventModel
          .findById(data.eventId)
          .session(session);
        if (!event || event.isDeleted) {
          throw new NotFoundException("Sự kiện không tồn tại");
        }

        const bookableStatuses: EventStatus[] = [EventStatus.ACTIVE];
        if (!bookableStatuses.includes(event.status)) {
          if (event.status === EventStatus.CANCELLED) {
            throw new BadRequestException("Sự kiện đã bị hủy");
          }
          throw new BadRequestException("Sự kiện chưa mở bán");
        }

        if (event.endDate < new Date()) {
          throw new BadRequestException("Sự kiện đã kết thúc");
        }

        const hasSlots = event.timeSlots && event.timeSlots.length > 0;
        if (hasSlots && !data.timeSlotId) {
          throw new BadRequestException(
            "Sự kiện này yêu cầu chọn khung giờ (timeSlotId)"
          );
        }
        if (data.timeSlotId) {
          if (!hasSlots) {
            throw new BadRequestException("Sự kiện này không có khung giờ");
          }
          const slotExists = event.timeSlots.some(
            (s) => s._id.toString() === data.timeSlotId
          );
          if (!slotExists) {
            throw new BadRequestException(
              "Khung giờ không hợp lệ hoặc không thuộc sự kiện này"
            );
          }
        }

        const zone = await this.zoneModel
          .findOne({
            _id: new Types.ObjectId(data.zoneId),
            eventId: new Types.ObjectId(data.eventId),
            isDeleted: false,
          })
          .session(session);

        if (!zone) {
          throw new NotFoundException("Khu vực không tồn tại");
        }

        const now = new Date();

        if (zone.saleStartDate && now < zone.saleStartDate) {
          throw new BadRequestException("Chưa tới thời gian bán vé");
        }

        if (zone.saleEndDate && now > zone.saleEndDate) {
          throw new BadRequestException("Đã hết thời gian bán vé");
        }

        const [existingUserUsage] = await this.bookingModel
          .aggregate([
            {
              $match: {
                userId: new Types.ObjectId(userId),
                eventId: new Types.ObjectId(data.eventId),
                status: {
                  $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED],
                },
                isDeleted: false,
              },
            },
            { $group: { _id: null, totalQuantity: { $sum: "$quantity" } } },
          ])
          .session(session);
        const existingUserTickets = existingUserUsage?.totalQuantity ?? 0;
        if (
          existingUserTickets + data.quantity >
          MAX_TICKETS_PER_USER_PER_EVENT
        ) {
          throw new BadRequestException(
            `Không thể mua quá ${MAX_TICKETS_PER_USER_PER_EVENT} vé cho một sự kiện`
          );
        }

        const originalTotalPrice = zone.price * data.quantity;
        const bookingData: BookingCreatePayload = {
          userId: new Types.ObjectId(userId),
          eventId: new Types.ObjectId(data.eventId),
          zoneId: new Types.ObjectId(data.zoneId),
          areaId: data.areaId ? new Types.ObjectId(data.areaId) : undefined,
          timeSlotId: data.timeSlotId
            ? new Types.ObjectId(data.timeSlotId)
            : undefined,
          seats: [],
          quantity: data.quantity,
          pricePerTicket: zone.price,
          originalTotalPrice,
          discountAmount: 0,
          totalPrice: originalTotalPrice,
          bookingCode: this.bookingCodeService.generateBookingCode(),
          expiresAt: new Date(Date.now() + BOOKING_EXPIRY_MS),
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          customerEmail: data.customerEmail,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          notes: data.notes,
        };

        let areaNameForSnapshot: string | undefined;

        if (zone.hasSeating) {
          if (!data.areaId) {
            throw new BadRequestException("Vui lòng chọn hàng ghế (area)");
          }
          const area = await this.areaModel
            .findOne({
              _id: new Types.ObjectId(data.areaId),
              zoneId: new Types.ObjectId(data.zoneId),
              isDeleted: false,
            })
            .select("seats name")
            .session(session);
          if (!area) {
            throw new NotFoundException("Hàng ghế không tồn tại");
          }
          areaNameForSnapshot = area.name;

          if (data.seats && data.seats.length > 0) {
            if (data.seats.length !== data.quantity) {
              throw new BadRequestException(
                "Số lượng ghế phải bằng số lượng vé"
              );
            }

            const uniqueSeats = new Set(data.seats);
            if (uniqueSeats.size !== data.seats.length) {
              throw new BadRequestException(
                "Danh sách ghế bị trùng, vui lòng chọn lại"
              );
            }

            const validSeats = area.seats || [];

            const invalidSeats = data.seats.filter(
              (seat) => !validSeats.includes(seat)
            );

            if (invalidSeats.length > 0) {
              throw new BadRequestException(
                `Các ghế không hợp lệ: ${invalidSeats.join(", ")}`
              );
            }

            const blockedSeats = await this.seatStateModel
              .find({
                eventId: new Types.ObjectId(data.eventId),
                areaId: new Types.ObjectId(data.areaId),
                seat: { $in: data.seats },
                $or: [
                  { expiresAt: { $exists: false } },
                  { expiresAt: { $gt: now } },
                ],
              })
              .session(session)
              .select("seat")
              .lean();

            if (blockedSeats.length > 0) {
              throw new BadRequestException(
                `Ghế không khả dụng: ${blockedSeats.map((s) => s.seat).join(", ")}`
              );
            }

            const conflict = await this.bookingModel
              .findOne({
                eventId: new Types.ObjectId(data.eventId),
                zoneId: new Types.ObjectId(data.zoneId),
                areaId: new Types.ObjectId(data.areaId),
                seats: { $in: data.seats },
                status: { $nin: ["cancelled", "expired"] },
                isDeleted: false,
              })
              .session(session)
              .select("_id");

            if (conflict) {
              throw new BadRequestException(
                "Một số ghế đã được đặt, vui lòng chọn lại"
              );
            }

            bookingData.seats = Array.from(uniqueSeats);
          } else {
            throw new BadRequestException(
              "Khu vực này yêu cầu chọn ghế cụ thể"
            );
          }
        } else {
          if (data.seats && data.seats.length > 0) {
            throw new BadRequestException(
              "Không thể chọn ghế cho khu vực không có chỗ ngồi"
            );
          }

          if (data.areaId) {
            throw new BadRequestException(
              "Không thể chọn hàng ghế cho khu vực không có chỗ ngồi"
            );
          }

          bookingData.seats = [];
          bookingData.areaId = undefined;
        }

        // Immutable copy of event/zone/area facts as of right now — later
        // edits to those documents (title, price, dates...) must never
        // rewrite how this booking reads in its own history/export/email.
        bookingData.snapshot = {
          eventTitle: event.title,
          eventStartDate: event.startDate,
          eventEndDate: event.endDate,
          location: event.location,
          zoneName: zone.name,
          areaName: areaNameForSnapshot,
          seats: bookingData.seats.length > 0 ? bookingData.seats : undefined,
          pricePerTicket: bookingData.pricePerTicket,
          currency: "VND",
        };

        const zoneUpdate = await this.zoneModel.findOneAndUpdate(
          {
            _id: new Types.ObjectId(data.zoneId),
            eventId: new Types.ObjectId(data.eventId),
            isDeleted: false,
            $expr: {
              $gte: [{ $subtract: ["$capacity", "$soldCount"] }, data.quantity],
            },
          },
          { $inc: { soldCount: data.quantity } },
          { session, new: true }
        );

        if (!zoneUpdate) {
          throw new BadRequestException("Không đủ vé");
        }
        changedZoneId = zoneUpdate._id as Types.ObjectId;

        const newBooking = new this.bookingModel(bookingData);
        if (data.promotionCode) {
          const appliedPromotion =
            await this.promotionService.applyPromotionToBooking(
              {
                code: data.promotionCode,
                userId,
                eventId: data.eventId,
                zoneId: data.zoneId,
                bookingId: (newBooking._id as Types.ObjectId).toString(),
                orderAmount: originalTotalPrice,
              },
              session
            );
          newBooking.originalTotalPrice = appliedPromotion.originalAmount;
          newBooking.discountAmount = appliedPromotion.discountAmount;
          newBooking.totalPrice = appliedPromotion.finalAmount;
          newBooking.promotionCode = appliedPromotion.code;
          newBooking.promotionId = new Types.ObjectId(
            appliedPromotion.promotionId
          );
        }
        await newBooking.save({ session });

        if (bookingData.seats.length > 0) {
          await this.seatLockModel.insertMany(
            bookingData.seats.map((seat) => ({
              eventId: new Types.ObjectId(data.eventId),
              areaId: new Types.ObjectId(data.areaId!),
              seat,
              bookingId: newBooking._id,
              expiresAt: bookingData.expiresAt,
            })),
            { session }
          );
        }

        result = {
          success: true,
          message: "Tạo booking thành công",
          data: this.bookingPresenter.toBookingListItem(newBooking),
        };
      });

      bookingCommitted = true;

      await Promise.allSettled([
        this.bookingCacheService.invalidateBookingCache(
          data.eventId,
          data.zoneId
        ),
        this.bookingCacheService.invalidateUserBookingCache(userId),
      ]);

      if (changedZoneId) {
        await this.bookingZoneNotifier
          .emitZoneTicketUpdate(changedZoneId)
          .catch((err: Error) =>
            this.logger.warn(
              `createBooking: emitZoneTicketUpdate failed post-commit: ${err.message}`
            )
          );
      }

      this.metricsService.bookingsTotal.inc({ status: "success" });
      this.logger.log(
        `createBooking: success — bookingCode=${result?.data?.bookingCode}, userId=${userId}, zoneId=${data.zoneId}, qty=${data.quantity}`
      );
      if (!result) {
        throw new BadRequestException("Booking creation did not complete");
      }
      await this.notificationService.notifyBookingCreated({
        userId,
        bookingId: result.data.id,
        bookingCode: result.data.bookingCode,
        eventId: data.eventId,
        eventTitle: result.data.event?.title,
        expiresAt: result.data.expiresAt,
      });
      return result;
    } catch (error) {
      if (!bookingCommitted && slotCapacity && slotCapacityReserved) {
        await this.redisService.client
          .decrBy(slotCapacity.counterKey, data.quantity)
          .catch((releaseError: unknown) => {
            this.logger.warn(
              `createBooking: failed to release slot reservation counterKey=${slotCapacity?.counterKey}, quantity=${data.quantity}: ${getErrorMessage(releaseError)}`
            );
          });
        slotCapacityReserved = false;
      }
      this.metricsService.bookingsTotal.inc({ status: "error" });
      this.logger.error(
        `createBooking: failed — userId=${userId}, zoneId=${data.zoneId}, error=${(error as Error)?.message}`
      );
      if (isDuplicateKeyError(error)) {
        this.metricsService.bookingConflictTotal.inc();
        throw new BadRequestException(
          "Một số ghế vừa được đặt bởi người khác, vui lòng chọn lại"
        );
      }
      throw error;
    } finally {
      session.endSession();
      await this.redisService.client
        .eval(RELEASE_LOCK_SCRIPT, {
          keys: [userEventLockKey],
          arguments: [userEventLockValue],
        })
        .catch((releaseError: unknown) => {
          this.logger.warn(
            `createBooking: failed to release user-event lock userId=${userId}, eventId=${data.eventId}: ${getErrorMessage(releaseError)}`
          );
        });
    }
  }
}
