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
import { FilterQuery, Model, Types } from "mongoose";
import { CreateBookingDto } from "./dto/create-booking.dto";
import { QueryBookingDto } from "./dto/query-booking.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { CancelBookingDto } from "./dto/cancel-booking.dto";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { ZoneService } from "@src/zone/zone.service";
import { RedisService } from "@src/redis/redis.service";
import {
  BOOKING_CACHE_TTL_MS,
  BOOKING_EXPIRY_MS,
  EXPIRE_BATCH_SIZE,
  MAX_TICKETS_PER_USER_PER_EVENT,
  SLOT_COUNTER_TTL_BUFFER_SEC,
  SLOT_SOLD_KEY_PREFIX,
  ZONE_INFO_STAMPEDE_LOCK_TTL_SEC,
  ZONE_INFO_STAMPEDE_MAX_POLLS,
  ZONE_INFO_STAMPEDE_POLL_DELAY_MS,
} from "./booking.constants";
import { isDuplicateKeyError } from "@src/common/utils/mongo.utils";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { UploadService } from "@src/upload/upload.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import {
  BookingCreatePayload,
  BookingCreateResult,
  SlotCapacityInfo,
} from "./booking.types";

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class BookingService {
  private readonly logger = new Logger(BookingService.name);

  constructor(
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(SeatLock.name) private seatLockModel: Model<SeatLock>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @InjectModel(Area.name) private areaModel: Model<Area>,
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Payment.name) private paymentModel: Model<Payment>,
    @InjectModel(SeatState.name) private seatStateModel: Model<SeatState>,
    private readonly zoneGateway: ZoneGateway,
    private readonly zoneService: ZoneService,
    private readonly redisService: RedisService,
    private readonly paymentService: PaymentService,
    private readonly metricsService: MetricsService,
    private readonly auditService: AuditService,
    private readonly uploadService: UploadService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  private assertObjectId(value: string, label: string): void {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
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

  private generateBookingCode(): string {
    const date = new Date();
    const year = date.getFullYear().toString();
    const month = (date.getMonth() + 1).toString().padStart(2, "0");
    const day = date.getDate().toString().padStart(2, "0");
    const timestamp =
      date.getHours().toString().padStart(2, "0") +
      date.getMinutes().toString().padStart(2, "0") +
      date.getSeconds().toString().padStart(2, "0");
    // 4 random bytes → 8 hex chars → ~4.3 billion values, safe under high concurrency
    const random = crypto.randomBytes(4).toString("hex").toUpperCase();

    return `BK${year}${month}${day}${timestamp}${random}`;
  }

  private generateBookingListCacheKey(
    query: QueryBookingDto,
    scopeKey: string
  ): string {
    const {
      eventId,
      search,
      status,
      paymentStatus,
      page,
      limit,
      sortBy,
      sortOrder,
    } = query;
    return `bookings:list:scope=${scopeKey}:event=${eventId || "all"}:search=${search || ""}:status=${status || "all"}:payment=${paymentStatus || "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  private readonly BOOKING_LIST_INDEX = "bookings:list:index";
  private readonly BOOKING_CACHE_TTL_SEC = Math.ceil(
    BOOKING_CACHE_TTL_MS / 1000
  );

  private async setBookingListCache(
    key: string,
    value: unknown
  ): Promise<void> {
    try {
      await Promise.all([
        this.redisService.client.set(key, JSON.stringify(value), {
          EX: this.BOOKING_CACHE_TTL_SEC,
        }),
        this.redisService.client.sAdd(this.BOOKING_LIST_INDEX, key),
        this.redisService.client.expire(
          this.BOOKING_LIST_INDEX,
          this.BOOKING_CACHE_TTL_SEC * 2
        ),
      ]);
    } catch {
      /* Non-fatal */
    }
  }

  private async invalidateBookingCache(
    eventId?: string,
    zoneId?: string
  ): Promise<void> {
    try {
      const keys = await this.redisService.client.sMembers(
        this.BOOKING_LIST_INDEX
      );
      const toDelete = [...keys, this.BOOKING_LIST_INDEX];
      if (eventId && zoneId) {
        toDelete.push(`zone:booking-info:event=${eventId}:zone=${zoneId}`);
      }
      await this.redisService.client.del(toDelete);
    } catch {
      /* Non-fatal */
    }
  }

  private async invalidateUserBookingCache(userId: string): Promise<void> {
    try {
      const indexKey = `bookings:user:${userId}:index`;
      const keys = await this.redisService.client.sMembers(indexKey);
      const toDelete = [...keys, indexKey];
      await this.redisService.client.del(toDelete);
    } catch {
      /* Non-fatal */
    }
  }

  async createBooking(userId: string, data: CreateBookingDto) {
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
            .catch(() => {});
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
          totalPrice: zone.price * data.quantity,
          bookingCode: this.generateBookingCode(),
          expiresAt: new Date(Date.now() + BOOKING_EXPIRY_MS),
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          customerEmail: data.customerEmail,
          customerName: data.customerName,
          customerPhone: data.customerPhone,
          notes: data.notes,
        };

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
            .select("seats")
            .session(session);
          if (!area) {
            throw new NotFoundException("Hàng ghế không tồn tại");
          }

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
          data: newBooking as unknown as {
            bookingCode: string;
            [key: string]: unknown;
          },
        };
      });

      // Booking is durably committed to Mongo at this point — nothing below
      // should trigger the slotCapacity compensation in the catch block,
      // since that would decrement Redis for a booking that actually exists.
      bookingCommitted = true;

      await Promise.allSettled([
        this.invalidateBookingCache(data.eventId, data.zoneId),
        this.invalidateUserBookingCache(userId),
      ]);

      if (changedZoneId) {
        await this.emitZoneTicketUpdate(changedZoneId).catch((err: Error) =>
          this.logger.warn(
            `createBooking: emitZoneTicketUpdate failed post-commit: ${err.message}`
          )
        );
      }

      this.metricsService.bookingsTotal.inc({ status: "success" });
      this.logger.log(
        `createBooking: success — bookingCode=${result?.data?.bookingCode}, userId=${userId}, zoneId=${data.zoneId}, qty=${data.quantity}`
      );
      return result;
    } catch (error) {
      if (!bookingCommitted && slotCapacity && slotCapacityReserved) {
        await this.redisService.client
          .decrBy(slotCapacity.counterKey, data.quantity)
          .catch(() => {});
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
        .catch(() => {});
    }
  }

  async getMyBookings(
    userId: string,
    status?: string,
    page: number = 1,
    limit: number = 10
  ) {
    const cacheKey = `bookings:user:${userId}:status=${status || "all"}:page=${page}:limit=${limit}`;
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as PaginatedResponse<Booking>;
    const filter: FilterQuery<Booking> = {
      userId: new Types.ObjectId(userId),
      isDeleted: false,
    };
    if (status) {
      filter.status = status;
    }
    const skip = (page - 1) * limit;
    const [bookings, total] = await Promise.all([
      this.bookingModel
        .find(filter)
        .populate("eventId", "title startDate endDate location thumbnail")
        .populate("zoneId", "name price hasSeating")
        .populate("areaId", "name rowLabel")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),
      this.bookingModel.countDocuments(filter),
    ]);
    const result = {
      success: true,
      items: bookings,
      meta: {
        currentPage: Number(page),
        itemsPerPage: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        hasPreviousPage: page > 1,
        hasNextPage: page < Math.ceil(total / limit),
      },
    };

    const userIndexKey = `bookings:user:${userId}:index`;
    await Promise.all([
      this.redisService.client.set(cacheKey, JSON.stringify(result), {
        EX: this.BOOKING_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(userIndexKey, cacheKey),
      this.redisService.client.expire(
        userIndexKey,
        this.BOOKING_CACHE_TTL_SEC * 2
      ),
    ]).catch(() => {});

    return result;
  }

  async getBookingByCode(userId: string, bookingCode: string) {
    const query: FilterQuery<Booking> = {
      bookingCode: bookingCode.trim().toUpperCase(),
      isDeleted: false,
    };
    if (userId) {
      query.userId = new Types.ObjectId(userId);
    }

    const booking = await this.bookingModel
      .findOne(query)
      .populate("eventId", "title startDate endDate location thumbnail")
      .populate("zoneId", "name price hasSeating")
      .populate("areaId", "name rowLabel");

    if (!booking) {
      throw new NotFoundException("Booking không tồn tại");
    }

    return {
      success: true,
      data: booking,
    };
  }

  async getZoneBookingInfo(eventId: string, zoneId: string) {
    this.assertObjectId(eventId, "event ID");
    this.assertObjectId(zoneId, "zone ID");
    const cacheKey = `zone:booking-info:event=${eventId}:zone=${zoneId}`;
    const lockKey = `${cacheKey}:lock`;

    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as Record<string, unknown>;

    const lockValue = `${process.pid}-${Date.now()}`;
    const lockAcquired = await this.redisService.client
      .set(lockKey, lockValue, {
        NX: true,
        EX: ZONE_INFO_STAMPEDE_LOCK_TTL_SEC,
      })
      .catch(() => null);

    if (!lockAcquired) {
      for (let i = 0; i < ZONE_INFO_STAMPEDE_MAX_POLLS; i++) {
        await new Promise<void>((r) =>
          setTimeout(r, ZONE_INFO_STAMPEDE_POLL_DELAY_MS)
        );
        const retryRaw = await this.redisService.client
          .get(cacheKey)
          .catch(() => null);
        if (retryRaw) return JSON.parse(retryRaw) as Record<string, unknown>;
      }
      this.logger.warn(
        `getZoneBookingInfo: stampede lock timed out for zone=${zoneId}, computing directly`
      );
    }

    try {
      const [event, zone] = await Promise.all([
        this.eventModel.findById(eventId),
        this.zoneModel.findOne({
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          isDeleted: false,
        }),
      ]);

      if (!event || event.isDeleted) {
        throw new NotFoundException("Sự kiện không tồn tại");
      }
      if (!zone) {
        throw new NotFoundException("Khu vực không tồn tại");
      }

      const availableTickets = zone.capacity - zone.soldCount;
      let areas: Awaited<ReturnType<typeof this.areaModel.find>> | null = null;
      let bookedSeatsByArea: Record<string, string[]> | null = null;

      if (zone.hasSeating) {
        const [fetchedAreas, bookedSeatsByAreaRaw] = await Promise.all([
          this.areaModel
            .find({ zoneId: new Types.ObjectId(zoneId), isDeleted: false })
            .select("name description rowLabel seatCount")
            .lean(),
          this.bookingModel.aggregate([
            {
              $match: {
                eventId: new Types.ObjectId(eventId),
                zoneId: new Types.ObjectId(zoneId),
                isDeleted: false,
                $or: [
                  { status: "confirmed" },
                  { status: "pending", expiresAt: { $gt: new Date() } },
                ],
              },
            },
            { $unwind: "$seats" },
            {
              $group: {
                _id: "$areaId",
                seats: { $addToSet: "$seats" },
              },
            },
          ]),
        ]);

        areas = fetchedAreas;
        bookedSeatsByArea = Object.fromEntries(
          (
            bookedSeatsByAreaRaw as {
              _id: Types.ObjectId | null;
              seats: string[];
            }[]
          )
            .filter((r) => r._id != null)
            .map(({ _id, seats }) => [
              (_id as Types.ObjectId).toString(),
              seats,
            ])
        );
      }

      const result = {
        success: true,
        data: {
          event: {
            _id: event._id,
            title: event.title,
            startDate: event.startDate,
            endDate: event.endDate,
            location: event.location,
          },
          zone: {
            _id: zone._id,
            name: zone.name,
            price: zone.price,
            hasSeating: zone.hasSeating,
            capacity: zone.capacity,
            soldCount: zone.soldCount,
            availableTickets,
            saleStartDate: zone.saleStartDate,
            saleEndDate: zone.saleEndDate,
          },
          areas,
          bookedSeatsByArea,
        },
      };

      const ttl = 5 + Math.floor(Math.random() * 3);
      await this.redisService.client
        .set(cacheKey, JSON.stringify(result), { EX: ttl })
        .catch(() => {});
      return result;
    } finally {
      if (lockAcquired) {
        await this.redisService.client
          .eval(RELEASE_LOCK_SCRIPT, {
            keys: [lockKey],
            arguments: [lockValue],
          })
          .catch(() => {});
      }
    }
  }

  async cancelBooking(userId: string, dto: CancelBookingDto) {
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
        this.invalidateBookingCache(changedEventKey, changedZoneKey),
        this.invalidateUserBookingCache(userId),
        changedZoneId
          ? this.zoneService.invalidateZoneAvailabilityCache(changedZoneId)
          : Promise.resolve(),
      ]);

      if (changedZoneId) {
        await this.emitZoneTicketUpdate(changedZoneId);
      }

      return { message: "Booking cancelled successfully" };
    } catch (error) {
      this.logger.error(
        `cancelBooking: failed — bookingCode=${bookingCode}, userId=${userId}, error=${(error as Error)?.message}`
      );
      throw error;
    } finally {
      session.endSession();
    }
  }

  async adminCancelBooking(
    bookingId: string,
    adminId: string,
    reason?: string
  ) {
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
          .catch(() => {});
      }

      await Promise.all([
        this.invalidateBookingCache(changedEventKey, changedZoneKey),
        bookedUserId
          ? this.invalidateUserBookingCache(bookedUserId)
          : Promise.resolve(),
        changedZoneId
          ? this.zoneService.invalidateZoneAvailabilityCache(changedZoneId)
          : Promise.resolve(),
      ]);

      if (changedZoneId) {
        await this.emitZoneTicketUpdate(changedZoneId);
      }

      if (cancelledTicketCodes.length > 0) {
        Promise.all(
          cancelledTicketCodes.map((code) =>
            this.uploadService
              .deleteQRCode(code)
              .catch((err: unknown) =>
                this.logger.warn(
                  `adminCancelBooking: QR cleanup failed for ${code}: ${(err as Error)?.message}`
                )
              )
          )
        ).catch(() => {});
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

      return { message: "Booking cancelled by admin" };
    } catch (error) {
      this.logger.error(
        `adminCancelBooking: failed — bookingId=${bookingId}, adminId=${adminId}, error=${(error as Error)?.message}`
      );
      throw error;
    } finally {
      session.endSession();
    }
  }

  private static readonly ALLOWED_BOOKING_SORT_FIELDS = new Set([
    "createdAt",
    "updatedAt",
    "totalPrice",
    "paidAt",
    "expiresAt",
  ]);

  async getAllBookings(
    query: QueryBookingDto,
    currentUser: JwtPayload
  ): Promise<PaginatedResponse<Booking>> {
    const {
      eventId,
      search,
      status,
      paymentStatus,
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;
    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!BookingService.ALLOWED_BOOKING_SORT_FIELDS.has(sortBy)) {
      throw new BadRequestException(
        `Invalid sortBy field. Allowed: ${[...BookingService.ALLOWED_BOOKING_SORT_FIELDS].join(", ")}`
      );
    }

    // Ownership gate MUST run before any cache read/write below — otherwise an
    // organizer could get a cache hit for data they were never authorized to see.
    let scopedEventIds: Types.ObjectId[] | undefined;
    let scopeKey = "admin";

    if (currentUser.role !== "admin") {
      if (eventId) {
        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          eventId
        );
        scopeKey = `event:${eventId}`;
      } else {
        const managedIds =
          await this.eventOwnershipService.getManagedEventIds(currentUser);
        if (managedIds.length === 0) {
          const totalPages = Math.ceil(0 / limit);
          return {
            items: [],
            meta: {
              currentPage: page,
              itemsPerPage: limit,
              totalItems: 0,
              totalPages,
              hasPreviousPage: page > 1,
              hasNextPage: false,
            },
          };
        }
        scopedEventIds = managedIds;
        scopeKey = `user:${currentUser.userId}`;
      }
    } else if (eventId) {
      scopeKey = `event:${eventId}`;
    }

    const cacheKey = this.generateBookingListCacheKey(query, scopeKey);
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as PaginatedResponse<Booking>;
    const filter: FilterQuery<Booking> = { isDeleted: false };

    if (eventId) filter.eventId = new Types.ObjectId(eventId);
    else if (scopedEventIds) filter.eventId = { $in: scopedEventIds };
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const skip = (page - 1) * limit;
    if (search) {
      const escapedSearch = this.escapeRegex(search.trim());

      if (escapedSearch) {
        filter.$or = [
          { bookingCode: { $regex: escapedSearch, $options: "i" } },
          { customerName: { $regex: escapedSearch, $options: "i" } },
          { customerEmail: { $regex: escapedSearch, $options: "i" } },
          { customerPhone: { $regex: escapedSearch, $options: "i" } },
          { notes: { $regex: escapedSearch, $options: "i" } },
        ];
      }
    }
    const sort: Record<string, 1 | -1> = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const [bookings, total] = await Promise.all([
      this.bookingModel.aggregate([
        { $match: filter },
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "events",
            localField: "eventId",
            foreignField: "_id",
            as: "eventId",
            pipeline: [{ $project: { title: 1, startDate: 1 } }],
          },
        },
        {
          $lookup: {
            from: "zones",
            localField: "zoneId",
            foreignField: "_id",
            as: "zoneId",
            pipeline: [{ $project: { name: 1, price: 1 } }],
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "userId",
            pipeline: [{ $project: { email: 1, name: 1 } }],
          },
        },
        {
          $addFields: {
            eventId: { $ifNull: [{ $arrayElemAt: ["$eventId", 0] }, null] },
            zoneId: { $ifNull: [{ $arrayElemAt: ["$zoneId", 0] }, null] },
            userId: { $ifNull: [{ $arrayElemAt: ["$userId", 0] }, null] },
          },
        },
      ]),
      this.bookingModel.countDocuments(filter),
    ]);
    const totalPages = Math.ceil(total / limit);
    const result: PaginatedResponse<Booking> = {
      items: bookings,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
    await this.setBookingListCache(cacheKey, result);
    return result;
  }

  async expirePendingBookings() {
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
          return {
            success: true,
            message: "Không có booking hết hạn",
            expired: 0,
          };
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
          return {
            success: true,
            message: "Không có booking hết hạn",
            expired: 0,
          };
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
          return {
            success: true,
            message: "Không có booking hết hạn",
            expired: 0,
          };
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

        return {
          success: true,
          message: `Đã expire ${expired} booking`,
          expired,
        };
      });

      await this.invalidateBookingCache();
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
            this.redisService.client
              .decrBy(`${SLOT_SOLD_KEY_PREFIX}${slotId}`, qty)
              .catch(() => {})
          )
        );
      }
      for (const zoneId of committedZoneIds) {
        await this.emitZoneTicketUpdate(zoneId);
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

  async cleanupOldBookings(before: Date) {
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
