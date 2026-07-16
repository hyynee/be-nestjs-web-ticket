import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { ClientSession, FilterQuery, Model, Types } from "mongoose";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import * as crypto from "crypto";
import * as QRCode from "qrcode";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { isDuplicateKeyError } from "@src/common/utils/mongo.utils";
import { TicketGateway } from "./ticket.gateway";
import { CheckInLog } from "@src/schemas/checkin-log.schema";
import { QueryTicketDto } from "./dto/query.dto";
import { MyTicketsQueryDto } from "./dto/my-tickets-query.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { RedisService } from "@src/redis/redis.service";
import { UploadService } from "@src/upload/upload.service";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import type {
  TicketBroadcastItem,
  TicketEventWindow,
  TimeSlotWindow,
  ZoneSeatMode,
} from "./types/ticket.types";

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

const CHECKIN_GRACE_MS = 30 * 60 * 1000; // 30 minutes before slot start

export function validateTimeSlotWindow(
  slot: TimeSlotWindow,
  now: Date
): { valid: boolean; message?: string } {
  const earliest = new Date(slot.startTime.getTime() - CHECKIN_GRACE_MS);
  if (now < earliest) {
    return {
      valid: false,
      message: `Chưa tới giờ check-in cho khung giờ "${slot.label}" (từ ${earliest.toISOString()})`,
    };
  }
  if (now > slot.endTime) {
    return {
      valid: false,
      message: `Khung giờ "${slot.label}" đã kết thúc lúc ${slot.endTime.toISOString()}`,
    };
  }
  return { valid: true };
}

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);

  constructor(
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
    @InjectModel(CheckInLog.name) private checkInLogModel: Model<CheckInLog>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    private ticketGateway: TicketGateway,
    private readonly redisService: RedisService,
    private readonly uploadService: UploadService,
    private readonly auditService: AuditService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  private generateListCacheKey(
    query: QueryTicketDto,
    scopeKey: string
  ): string {
    const {
      eventId,
      zoneId,
      areaId,
      status,
      ticketCode,
      userId,
      page,
      limit,
      sortBy,
      sortOrder,
    } = query;
    return `tickets:list:scope=${scopeKey}:event=${eventId || "all"}:zone=${zoneId || "all"}:area=${areaId || "all"}:status=${status || "all"}:ticketCode=${ticketCode || ""}:userId=${userId || "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private readonly TICKET_LIST_INDEX = "tickets:list:index";
  private readonly TICKET_CACHE_TTL_SEC = 30;

  private async invalidateTicketCache(): Promise<void> {
    try {
      const keys = await this.redisService.client.sMembers(
        this.TICKET_LIST_INDEX
      );
      const toDelete = [...keys, this.TICKET_LIST_INDEX];
      await this.redisService.client.del(toDelete);
    } catch {
      /* Non-fatal */
    }
  }

  private async invalidateUserTicketCache(userId: string): Promise<void> {
    try {
      const indexKey = `tickets:user:${userId}:index`;
      const keys = await this.redisService.client.sMembers(indexKey);
      const toDelete = [...keys, indexKey];
      await this.redisService.client.del(toDelete);
    } catch {
      /* Non-fatal */
    }
  }

  async publishTicketCreation(
    bookingCode: string,
    tickets: TicketBroadcastItem[],
    userId?: string
  ): Promise<void> {
    this.ticketGateway.emitTicketCreated({
      bookingCode,
      tickets: tickets.map((ticket) => ({
        ticketCode: ticket.ticketCode,
        eventId: ticket.eventId,
        zoneId: ticket.zoneId,
        seatNumber: ticket.seatNumber || null,
        price: ticket.price,
        status: ticket.status,
      })),
    });

    await this.invalidateTicketCache();
    if (userId) {
      await this.invalidateUserTicketCache(userId);
    }
  }

  // tạo ticket code unique
  private generateTicketCode(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(6).toString("hex").toUpperCase();
    return `TK${timestamp}${random}`;
  }
  // tạo qr code từ ticket code và upload lên Cloudinary, trả về URL
  private async generateQRCode(ticketCode: string): Promise<string> {
    try {
      const buffer = await QRCode.toBuffer(ticketCode, {
        errorCorrectionLevel: "H",
        type: "png",
        width: 300,
        margin: 1,
      });
      const url = await this.uploadService.uploadQRCodeBuffer(
        buffer,
        ticketCode
      );
      return url;
    } catch (error) {
      this.logger.error(
        `Error generating QR code: ${(error as Error)?.message}`
      );
      throw new BadRequestException("Failed to generate QR code");
    }
  }
  async createTicketsFromBooking(
    bookingCode: string,
    session?: ClientSession,
    requesterUserId?: string
  ) {
    const normalizedCode = bookingCode.trim().toUpperCase();
    const booking = await this.bookingModel
      .findOne({ bookingCode: normalizedCode, isDeleted: false })
      .populate("zoneId", "hasSeating")
      .session(session ?? null)
      .exec();

    if (!booking) {
      throw new BadRequestException("Invalid booking code");
    }

    if (requesterUserId && booking.userId.toString() !== requesterUserId) {
      throw new ForbiddenException(
        "You are not allowed to issue tickets for this booking"
      );
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException("Booking is not confirmed");
    }

    const bookingId = (booking._id as Types.ObjectId).toString();

    const shouldUseLock = !session;
    const lockKey = `ticket:create:lock:${bookingId}`;
    const lockValue = crypto.randomBytes(8).toString("hex");
    let lockAcquired = false;

    if (shouldUseLock) {
      const acquired = await this.redisService.client.set(lockKey, lockValue, {
        NX: true,
        EX: 300,
      });

      if (!acquired) {
        const existing = await this.ticketModel
          .find({ bookingId: booking._id, isDeleted: false })
          .session(session ?? null)
          .exec();
        if (existing.length > 0) return existing;
        throw new ConflictException(
          "Ticket creation is already in progress for this booking. Please retry in a moment."
        );
      }
      lockAcquired = true;
    }

    try {
      const existingTickets = await this.ticketModel
        .find({ bookingId: booking._id, isDeleted: false })
        .session(session ?? null)
        .exec();

      if (existingTickets.length > 0) return existingTickets;

      const ticketsData: any[] = [];
      const zone = booking.zoneId as unknown as ZoneSeatMode;

      const timeSlotId = booking.timeSlotId
        ? new Types.ObjectId(booking.timeSlotId)
        : undefined;

      if (Boolean(zone.hasSeating) && booking.seats?.length) {
        for (const seat of booking.seats) {
          ticketsData.push({
            bookingId: booking._id,
            eventId: new Types.ObjectId(booking.eventId),
            zoneId: new Types.ObjectId(booking.zoneId),
            areaId: booking.areaId
              ? new Types.ObjectId(booking.areaId)
              : undefined,
            timeSlotId,
            seatNumber: seat,
            status: "valid",
            price: booking.pricePerTicket,
            userId: new Types.ObjectId(booking.userId),
            ticketCode: this.generateTicketCode(),
          });
        }
      } else {
        for (let i = 0; i < booking.quantity; i++) {
          ticketsData.push({
            bookingId: booking._id,
            eventId: new Types.ObjectId(booking.eventId),
            zoneId: new Types.ObjectId(booking.zoneId),
            areaId: booking.areaId
              ? new Types.ObjectId(booking.areaId)
              : undefined,
            timeSlotId,
            userId: new Types.ObjectId(booking.userId),
            ticketCode: this.generateTicketCode(),
            price: booking.pricePerTicket,
            status: "valid",
          });
        }
      }

      const documentsToInsert = session
        ? ticketsData
        : await Promise.all(
            ticketsData.map(async (data) => ({
              ...data,
              qrCode: await this.generateQRCode(data.ticketCode),
            }))
          );

      let createdTickets: any[];
      try {
        createdTickets = await this.ticketModel.insertMany(documentsToInsert, {
          session,
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const existing = await this.ticketModel
            .find({ bookingId: booking._id, isDeleted: false })
            .session(session ?? null)
            .exec();
          if (existing.length > 0) return existing;
        }
        throw err;
      }

      if (!session) {
        await this.publishTicketCreation(
          booking.bookingCode,
          createdTickets,
          booking.userId?.toString()
        );
      }

      return createdTickets;
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

  async generateMissingQRCodesForBooking(
    bookingCode: string
  ): Promise<Ticket[]> {
    const normalizedCode = bookingCode.trim().toUpperCase();
    const booking = await this.bookingModel
      .findOne({ bookingCode: normalizedCode, isDeleted: false })
      .select("_id bookingCode userId")
      .lean();

    if (!booking) {
      throw new BadRequestException("Invalid booking code");
    }

    const tickets = await this.ticketModel
      .find({ bookingId: booking._id, isDeleted: false })
      .exec();

    if (!tickets.length) {
      throw new BadRequestException("No tickets found for booking");
    }

    const missingQrTickets = tickets.filter((ticket) => !ticket.qrCode);
    if (!missingQrTickets.length) {
      return tickets;
    }

    const updates = await Promise.all(
      missingQrTickets.map(async (ticket) => ({
        updateOne: {
          filter: {
            _id: ticket._id,
            isDeleted: false,
            qrCode: { $exists: false },
          },
          update: {
            $set: {
              qrCode: await this.generateQRCode(ticket.ticketCode),
            },
          },
        },
      }))
    );

    await this.ticketModel.bulkWrite(updates);

    const refreshedTickets = await this.ticketModel
      .find({ bookingId: booking._id, isDeleted: false })
      .exec();

    await this.publishTicketCreation(
      normalizedCode,
      refreshedTickets,
      booking.userId?.toString()
    );

    return refreshedTickets;
  }
  async getTicketByCode(userId: string, ticketCode: string) {
    if (!userId) {
      throw new BadRequestException(
        "User ID is required to get ticket details"
      );
    }
    const ticket = await this.ticketModel
      .findOne({
        ticketCode,
        isDeleted: false,
        userId: new Types.ObjectId(userId),
      })
      .populate("eventId", "title location startDate endDate")
      .populate("zoneId", "name")
      .populate("areaId", "name")
      .populate("bookingId", "snapshot")
      .lean()
      .exec();
    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    // Prefer the booking's immutable snapshot (facts as of booking time)
    // over the live-populated Event/Zone/Area — a ticket viewed long after
    // an event was renamed/rescheduled should still show what the customer
    // actually booked. Ticket itself has no snapshot of its own; it's
    // reached through bookingId.
    const snapshot = (ticket as any).bookingId?.snapshot;
    if (snapshot) {
      if (ticket.eventId && typeof ticket.eventId === "object") {
        Object.assign(ticket.eventId, {
          title: snapshot.eventTitle,
          location: snapshot.location,
          startDate: snapshot.eventStartDate,
          endDate: snapshot.eventEndDate,
        });
      }
      if (ticket.zoneId && typeof ticket.zoneId === "object") {
        Object.assign(ticket.zoneId, { name: snapshot.zoneName });
      }
      if (
        snapshot.areaName &&
        ticket.areaId &&
        typeof ticket.areaId === "object"
      ) {
        Object.assign(ticket.areaId, { name: snapshot.areaName });
      }
    }

    return ticket;
  }

  async validateTicket(ticketCode: string, currentUser: JwtPayload) {
    const ticket = await this.ticketModel
      .findOne({ ticketCode, isDeleted: false })
      .populate(
        "eventId",
        "startDate endDate timeSlots createdBy organizerIds staffIds"
      )
      .exec();
    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    const isOwnTicket = ticket.userId?.toString() === currentUser.userId;
    const canCheckIn =
      isOwnTicket ||
      (ticket.eventId &&
        this.eventOwnershipService.hasCheckInAccess(
          currentUser,
          ticket.eventId as unknown as {
            createdBy: Types.ObjectId;
            organizerIds?: Types.ObjectId[];
            staffIds?: Types.ObjectId[];
          }
        ));

    if (!canCheckIn) {
      throw new ForbiddenException(
        "You are not allowed to validate this ticket"
      );
    }

    if (ticket.status === "used") {
      return {
        valid: false,
        message: "Vé đã được sử dụng",
        usedAt: ticket.checkedInAt,
      };
    }
    if (ticket.status === "cancelled") {
      return {
        valid: false,
        message: "Vé đã bị hủy",
      };
    }
    if (ticket.status === "expired") {
      return {
        valid: false,
        message: "Vé đã hết hạn",
      };
    }
    const event = ticket.eventId as unknown as TicketEventWindow & {
      timeSlots?: TimeSlotWindow[];
    };
    if (!event) {
      throw new BadRequestException("Event not found for this ticket");
    }
    const now = new Date();
    if (now < event.startDate) {
      return {
        valid: false,
        message: "Sự kiện chưa bắt đầu, vé chưa thể sử dụng",
      };
    }
    if (now > event.endDate) {
      return {
        valid: false,
        message: "Sự kiện đã kết thúc, vé không còn giá trị sử dụng",
      };
    }

    if (ticket.timeSlotId) {
      const slot = event.timeSlots?.find(
        (s) => s._id.toString() === ticket.timeSlotId!.toString()
      );
      if (!slot) {
        return {
          valid: false,
          message: "Khung giờ của vé này không còn tồn tại trong sự kiện",
        };
      }
      const check = validateTimeSlotWindow(slot, now);
      if (!check.valid) {
        return { valid: false, message: check.message };
      }
    }

    return {
      valid: true,
      message: "Vé hợp lệ, có thể sử dụng",
      ticket,
    };
  }

  async checkInTicket(
    ticketCode: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    currentUser: JwtPayload
  ) {
    const adminId = currentUser.userId;
    const dbSession = await this.ticketModel.db.startSession();
    let updatedTicket: any = null;
    let ticketId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const ticket = await this.ticketModel
          .findOne({ ticketCode, isDeleted: false })
          .populate(
            "eventId",
            "startDate endDate timeSlots createdBy organizerIds staffIds"
          )
          .session(dbSession)
          .exec();

        if (!ticket) {
          throw new BadRequestException(
            "Ticket không hợp lệ hoặc đã được check-in"
          );
        }

        ticketId = ticket._id as Types.ObjectId;

        if (!ticket.eventId) {
          throw new BadRequestException("Event not found");
        }

        if (
          !this.eventOwnershipService.hasCheckInAccess(
            currentUser,
            ticket.eventId as unknown as {
              createdBy: Types.ObjectId;
              organizerIds?: Types.ObjectId[];
              staffIds?: Types.ObjectId[];
            }
          )
        ) {
          throw new ForbiddenException(
            "You are not allowed to check in tickets for this event"
          );
        }

        if (ticket.status !== "valid") {
          const reason =
            ticket.status === "used"
              ? "Vé đã được check-in bởi thiết bị khác"
              : ticket.status === "expired"
                ? "Vé đã hết hạn"
                : "Vé không hợp lệ vì đã bị hủy hoặc hoàn tiền";

          await this.checkInLogModel.create(
            [
              {
                ticketId: ticket._id,
                adminId,
                location,
                deviceInfo,
                ipAddress,
                success: false,
                message: `Failed: ticket is ${ticket.status}`,
              },
            ],
            { session: dbSession }
          );
          throw new BadRequestException(reason);
        }

        const event = ticket.eventId as unknown as TicketEventWindow & {
          timeSlots?: TimeSlotWindow[];
        };
        const now = new Date();

        if (now < event.startDate) {
          throw new BadRequestException(
            "Sự kiện chưa bắt đầu, không thể check-in"
          );
        }

        if (now > event.endDate) {
          await this.ticketModel.updateOne(
            { _id: ticket._id, status: "valid", isDeleted: false },
            { $set: { status: "expired" } },
            { session: dbSession }
          );
          throw new BadRequestException("Sự kiện đã kết thúc, vé đã hết hạn");
        }

        if (ticket.timeSlotId) {
          const slot = event.timeSlots?.find(
            (s) => s._id.toString() === ticket.timeSlotId!.toString()
          );
          if (!slot) {
            await this.checkInLogModel.create(
              [
                {
                  ticketId: ticket._id,
                  adminId,
                  location,
                  deviceInfo,
                  ipAddress,
                  success: false,
                  message: "Failed: time slot no longer exists on event",
                },
              ],
              { session: dbSession }
            );
            throw new BadRequestException(
              "Khung giờ của vé này không còn tồn tại trong sự kiện"
            );
          }
          const check = validateTimeSlotWindow(slot, now);
          if (!check.valid) {
            await this.checkInLogModel.create(
              [
                {
                  ticketId: ticket._id,
                  adminId,
                  location,
                  deviceInfo,
                  ipAddress,
                  success: false,
                  message: `Failed: outside time slot window — ${check.message}`,
                },
              ],
              { session: dbSession }
            );
            throw new BadRequestException(check.message);
          }
        }

        updatedTicket = await this.ticketModel.findOneAndUpdate(
          { _id: ticket._id, status: "valid", isDeleted: false },
          {
            $set: {
              status: "used",
              checkedInAt: now,
              checkInLocation: location,
              checkedInBy: new Types.ObjectId(adminId),
              metadata: { deviceInfo, ipAddress },
            },
          },
          { new: true, session: dbSession }
        );

        if (!updatedTicket) {
          // Lost the race to another concurrent check-in
          const current = await this.ticketModel
            .findOne({ _id: ticket._id, isDeleted: false })
            .select("status")
            .session(dbSession)
            .lean()
            .exec();

          const isExpired = current?.status === "expired";
          const isCancelled = current?.status === "cancelled";
          await this.checkInLogModel.create(
            [
              {
                ticketId: ticket._id,
                adminId,
                location,
                deviceInfo,
                ipAddress,
                success: false,
                message: isExpired
                  ? "Failed: ticket expired concurrently"
                  : isCancelled
                    ? "Failed: ticket was cancelled"
                    : "Failed: already used by another device",
              },
            ],
            { session: dbSession }
          );
          throw new BadRequestException(
            isExpired
              ? "Vé đã hết hạn"
              : isCancelled
                ? "Vé không hợp lệ vì đã bị hủy hoặc hoàn tiền"
                : "Vé đã được check-in bởi thiết bị khác"
          );
        }

        await this.checkInLogModel.create(
          [
            {
              ticketId: ticket._id,
              adminId,
              location,
              deviceInfo,
              ipAddress,
              success: true,
              message: "Check-in success",
            },
          ],
          { session: dbSession }
        );
      });
    } finally {
      await dbSession.endSession();
    }

    if (!updatedTicket) {
      throw new BadRequestException(
        "Ticket không hợp lệ hoặc đã được check-in"
      );
    }

    await Promise.all([
      this.invalidateTicketCache(),
      this.invalidateUserTicketCache(updatedTicket.userId?.toString() ?? ""),
    ]).catch(() => {});

    this.ticketGateway.emitTicketCheckedIn({
      ticketCode: updatedTicket.ticketCode,
      eventId: updatedTicket.eventId,
      zoneId: updatedTicket.zoneId,
      seatNumber: updatedTicket.seatNumber || null,
      checkedInAt: updatedTicket.checkedInAt as Date,
    });

    try {
      await this.auditService.record({
        action: AuditAction.TICKET_CHECKIN,
        actorId: adminId,
        actorRole: currentUser.role,
        ticketId: ticketId
          ? (ticketId as Types.ObjectId).toString()
          : undefined,
        ipAddress,
        metadata: {
          location,
          deviceInfo,
          ticketCode: updatedTicket.ticketCode,
        },
      });
    } catch (auditErr) {
      this.logger.error(
        `checkInTicket: audit record FAILED for ticketCode=${updatedTicket.ticketCode} — ${(auditErr as Error)?.message}. MANUAL AUDIT REQUIRED.`
      );
    }

    return {
      success: true,
      message: "Ticket checked in successfully",
      ticket: updatedTicket,
    };
  }

  async cancelTicket(ticketCode: string, userId: string) {
    const dbSession = await this.ticketModel.db.startSession();
    let cancelledTicket: any = null;

    try {
      await dbSession.withTransaction(async () => {
        // Check booking status BEFORE cancelling the ticket.
        // If the booking is CONFIRMED+PAID, block individual ticket cancellation —
        // the user must request a full booking cancellation via admin.
        const ticketForCheck = await this.ticketModel
          .findOne({
            ticketCode,
            userId: new Types.ObjectId(userId),
            status: { $in: ["valid"] },
            isDeleted: false,
          })
          .select("bookingId")
          .session(dbSession)
          .lean();

        if (!ticketForCheck) {
          throw new BadRequestException(
            "Vé đã được sử dụng, đã bị hủy hoặc không tồn tại"
          );
        }

        const bookingCheck = await this.bookingModel
          .findById(ticketForCheck.bookingId)
          .select("status paymentStatus")
          .session(dbSession)
          .lean();

        if (
          bookingCheck?.status === BookingStatus.CONFIRMED &&
          bookingCheck?.paymentStatus === PaymentStatus.PAID
        ) {
          throw new BadRequestException(
            "Không thể hủy vé riêng lẻ cho booking đã thanh toán. Vui lòng liên hệ admin để hủy toàn bộ booking và nhận hoàn tiền."
          );
        }

        const ticket = await this.ticketModel.findOneAndUpdate(
          {
            ticketCode,
            userId: new Types.ObjectId(userId),
            status: { $in: ["valid"] },
            isDeleted: false,
          },
          {
            $set: {
              status: "cancelled",
              cancelledAt: new Date(),
              cancelledBy: new Types.ObjectId(userId),
            },
          },
          { new: true, session: dbSession }
        );

        if (!ticket) {
          throw new BadRequestException(
            "Vé đã được sử dụng, đã bị hủy hoặc không tồn tại"
          );
        }

        cancelledTicket = ticket;

        // Restore zone inventory. Look up the booking to determine whether the
        // booking was confirmed+paid so we can also decrement confirmedSoldCount.
        const booking = await this.bookingModel
          .findById(ticket.bookingId)
          .select("status paymentStatus")
          .session(dbSession)
          .lean();

        const isConfirmedAndPaid =
          booking?.status === BookingStatus.CONFIRMED &&
          booking?.paymentStatus === PaymentStatus.PAID;

        await this.zoneModel.updateOne(
          { _id: ticket.zoneId },
          [
            {
              $set: {
                soldCount: { $max: [{ $subtract: ["$soldCount", 1] }, 0] },
              },
            },
          ],
          { session: dbSession }
        );

        if (isConfirmedAndPaid) {
          await this.zoneModel.updateOne(
            { _id: ticket.zoneId },
            [
              {
                $set: {
                  confirmedSoldCount: {
                    $max: [{ $subtract: ["$confirmedSoldCount", 1] }, 0],
                  },
                },
              },
            ],
            { session: dbSession }
          );
        }

        const remainingValid = await this.ticketModel.countDocuments(
          { bookingId: ticket.bookingId, status: "valid", isDeleted: false },
          { session: dbSession }
        );
        if (remainingValid === 0) {
          await this.bookingModel.updateOne(
            {
              _id: ticket.bookingId,
              status: {
                $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED],
              },
            },
            {
              $set: {
                status: BookingStatus.CANCELLED,
                cancelledAt: new Date(),
                cancellationReason: "All tickets cancelled by user",
              },
            },
            { session: dbSession }
          );
        }

        this.uploadService.deleteQRCode(ticketCode).catch((err: unknown) => {
          this.logger.warn(
            `cancelTicket: failed to delete QR for ${ticketCode}: ${(err as Error)?.message}`
          );
        });
      });
    } finally {
      await dbSession.endSession();
    }

    await Promise.all([
      this.invalidateTicketCache(),
      this.invalidateUserTicketCache(userId),
    ]);

    return {
      success: true,
      message: "Ticket with code " + ticketCode + " cancelled successfully",
      ticket: {
        ticketCode: cancelledTicket.ticketCode,
        seatNumber: cancelledTicket.seatNumber,
        zoneId: cancelledTicket.zoneId,
        areaId: cancelledTicket.areaId || null,
      },
    };
  }

  // admin
  async getAllTickets(
    query: QueryTicketDto,
    currentUser: JwtPayload
  ): Promise<PaginatedResponse<Ticket>> {
    const {
      eventId,
      zoneId,
      areaId,
      status,
      ticketCode,
      userId,
      page = 1,
      limit = 10,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;

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

    const cacheKey = this.generateListCacheKey(query, scopeKey);
    const cachedRaw = await this.redisService.client
      .get(cacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as PaginatedResponse<Ticket>;

    const skip = (page - 1) * limit;

    const filter: FilterQuery<Ticket> = { isDeleted: false };

    if (eventId) filter.eventId = new Types.ObjectId(eventId);
    else if (scopedEventIds) filter.eventId = { $in: scopedEventIds };
    if (zoneId) filter.zoneId = new Types.ObjectId(zoneId);
    if (areaId) filter.areaId = new Types.ObjectId(areaId);
    if (userId) filter.userId = new Types.ObjectId(userId);
    if (status) filter.status = status;

    if (ticketCode) {
      filter.ticketCode = {
        $regex: escapeRegex(ticketCode.trim()),
        $options: "i",
      };
    }

    const allowedSortFields = ["createdAt", "price", "status"];
    const finalSortBy = allowedSortFields.includes(sortBy)
      ? sortBy
      : "createdAt";

    const sort: Record<string, 1 | -1> = {
      [finalSortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const lookupStages = [
      // Exclude qrCode from list responses — it's a Cloudinary URL (was base64 ~50KB).
      // qrCode is returned only on the single-ticket GET endpoint.
      { $project: { qrCode: 0 } },
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
          from: "bookings",
          localField: "bookingId",
          foreignField: "_id",
          as: "bookingId",
          pipeline: [{ $project: { bookingCode: 1 } }],
        },
      },
      {
        $lookup: {
          from: "zones",
          localField: "zoneId",
          foreignField: "_id",
          as: "zoneId",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $lookup: {
          from: "areas",
          localField: "areaId",
          foreignField: "_id",
          as: "areaId",
          pipeline: [{ $project: { name: 1 } }],
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
        $lookup: {
          from: "users",
          localField: "checkedInBy",
          foreignField: "_id",
          as: "checkedInBy",
          pipeline: [{ $project: { email: 1, name: 1 } }],
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "cancelledBy",
          foreignField: "_id",
          as: "cancelledBy",
          pipeline: [{ $project: { email: 1, name: 1 } }],
        },
      },
      {
        $addFields: {
          eventId: { $ifNull: [{ $arrayElemAt: ["$eventId", 0] }, null] },
          bookingId: { $ifNull: [{ $arrayElemAt: ["$bookingId", 0] }, null] },
          zoneId: { $ifNull: [{ $arrayElemAt: ["$zoneId", 0] }, null] },
          areaId: { $ifNull: [{ $arrayElemAt: ["$areaId", 0] }, null] },
          userId: { $ifNull: [{ $arrayElemAt: ["$userId", 0] }, null] },
          checkedInBy: {
            $ifNull: [{ $arrayElemAt: ["$checkedInBy", 0] }, null],
          },
          cancelledBy: {
            $ifNull: [{ $arrayElemAt: ["$cancelledBy", 0] }, null],
          },
        },
      },
    ];

    const [tickets, total] = await Promise.all([
      this.ticketModel.aggregate([
        { $match: filter },
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        ...lookupStages,
      ]),
      this.ticketModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    const result: PaginatedResponse<Ticket> = {
      items: tickets,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };

    await Promise.all([
      this.redisService.client.set(cacheKey, JSON.stringify(result), {
        EX: this.TICKET_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(this.TICKET_LIST_INDEX, cacheKey),
      this.redisService.client.expire(
        this.TICKET_LIST_INDEX,
        this.TICKET_CACHE_TTL_SEC * 2
      ),
    ]).catch(() => {});

    return result;
  }
  async getMyTickets(
    userId: string,
    query: MyTicketsQueryDto
  ): Promise<PaginatedResponse<Ticket>> {
    const {
      bookingId,
      eventId,
      status,
      ticketCode,
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;

    const userCacheKey = `tickets:user:${userId}:bookingId=${bookingId || "all"}:eventId=${eventId || "all"}:status=${status || "all"}:ticketCode=${ticketCode || ""}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
    const userIndexKey = `tickets:user:${userId}:index`;

    const cachedRaw = await this.redisService.client
      .get(userCacheKey)
      .catch(() => null);
    if (cachedRaw) return JSON.parse(cachedRaw) as PaginatedResponse<Ticket>;

    const skip = (page - 1) * limit;

    const filter: FilterQuery<Ticket> = {
      userId: new Types.ObjectId(userId),
      isDeleted: false,
    };

    if (bookingId) filter.bookingId = new Types.ObjectId(bookingId);
    if (eventId) filter.eventId = new Types.ObjectId(eventId);
    if (status) filter.status = status;
    if (ticketCode) {
      filter.ticketCode = {
        $regex: escapeRegex(ticketCode.trim()),
        $options: "i",
      };
    }

    const allowedSortFields = ["createdAt", "price", "status"];
    const finalSortBy = allowedSortFields.includes(sortBy)
      ? sortBy
      : "createdAt";

    const sort: Record<string, 1 | -1> = {
      [finalSortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const lookupStages = [
      {
        $lookup: {
          from: "events",
          localField: "eventId",
          foreignField: "_id",
          as: "eventId",
          pipeline: [
            { $project: { title: 1, startDate: 1, endDate: 1, location: 1 } },
          ],
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "bookingId",
          foreignField: "_id",
          as: "bookingId",
          pipeline: [{ $project: { bookingCode: 1 } }],
        },
      },
      {
        $lookup: {
          from: "zones",
          localField: "zoneId",
          foreignField: "_id",
          as: "zoneId",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $lookup: {
          from: "areas",
          localField: "areaId",
          foreignField: "_id",
          as: "areaId",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $addFields: {
          eventId: { $ifNull: [{ $arrayElemAt: ["$eventId", 0] }, null] },
          bookingId: { $ifNull: [{ $arrayElemAt: ["$bookingId", 0] }, null] },
          zoneId: { $ifNull: [{ $arrayElemAt: ["$zoneId", 0] }, null] },
          areaId: { $ifNull: [{ $arrayElemAt: ["$areaId", 0] }, null] },
        },
      },
    ];

    const [tickets, total] = await Promise.all([
      this.ticketModel.aggregate([
        { $match: filter },
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        ...lookupStages,
      ]),
      this.ticketModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    const result: PaginatedResponse<Ticket> = {
      items: tickets,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };

    await Promise.all([
      this.redisService.client.set(userCacheKey, JSON.stringify(result), {
        EX: this.TICKET_CACHE_TTL_SEC,
      }),
      this.redisService.client.sAdd(userIndexKey, userCacheKey),
      this.redisService.client.expire(
        userIndexKey,
        this.TICKET_CACHE_TTL_SEC * 2
      ),
    ]).catch(() => {});

    return result;
  }

  // thống kê vé
  // lấy lịch sử checkin của vé
  async getCheckInHistory(ticketCode: string, currentUser: JwtPayload) {
    const ticket = await this.ticketModel
      .findOne({ ticketCode, isDeleted: false })
      .select("_id eventId")
      .lean()
      .exec();

    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      (ticket.eventId as Types.ObjectId).toString()
    );

    const [eventResult, logs] = await Promise.all([
      this.ticketModel.aggregate([
        { $match: { _id: ticket._id } },
        {
          $lookup: {
            from: "events",
            localField: "eventId",
            foreignField: "_id",
            as: "event",
            pipeline: [{ $project: { title: 1 } }],
          },
        },
        {
          $project: {
            eventTitle: {
              $ifNull: [{ $arrayElemAt: ["$event.title", 0] }, ""],
            },
          },
        },
      ]),
      this.checkInLogModel.aggregate([
        { $match: { ticketId: ticket._id } },
        { $sort: { createdAt: -1 } },
        { $limit: 50 },
        {
          $lookup: {
            from: "users",
            localField: "adminId",
            foreignField: "_id",
            as: "adminId",
            pipeline: [{ $project: { name: 1 } }],
          },
        },
        {
          $addFields: {
            adminId: { $ifNull: [{ $arrayElemAt: ["$adminId", 0] }, null] },
          },
        },
      ]),
    ]);

    return {
      ticketCode,
      eventTitle: (eventResult[0]?.eventTitle as string) ?? "",
      history: logs,
    };
  }
}
