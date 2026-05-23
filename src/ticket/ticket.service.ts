import {
  Injectable,
  Inject,
  BadRequestException,
  ForbiddenException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { ClientSession, FilterQuery, Model, Types } from "mongoose";
import { Event } from "@src/schemas/event.schema";
import * as crypto from "crypto";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import * as QRCode from "qrcode";
import { TicketGateway } from "./ticket.gateway";
import { CheckInLog } from "@src/schemas/checkin-log.schema";
import { QueryTicketDto } from "./dto/query.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import type {
  TicketBroadcastItem,
  TicketEventTitle,
  TicketEventWindow,
  ZoneSeatMode,
} from "./types/ticket.types";

@Injectable()
export class TicketService {
  private readonly TICKETS_CACHE_LIST_KEY = new Set<string>(); // cache list admin
  private readonly USER_TICKETS_CACHE_KEY = new Set<string>(); // cache list user
  constructor(
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
    @InjectModel(CheckInLog.name) private checkInLogModel: Model<CheckInLog>,
    private ticketGateway: TicketGateway,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
  ) {}

  private generateListCacheKey(query: QueryTicketDto): string {
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
    return `tickets:list:event=${eventId || "all"}:zone=${zoneId || "all"}:area=${areaId || "all"}:status=${status || "all"}:ticketCode=${ticketCode || ""}:userId=${userId || "all"}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
  }

  private async invalidateTicketCache(): Promise<void> {
    for (const key of this.TICKETS_CACHE_LIST_KEY) {
      await this.cacheManager.del(key);
    }
    this.TICKETS_CACHE_LIST_KEY.clear();
  }

  private async invalidateUserTicketCache(userId: string): Promise<void> {
    const keysToDelete: string[] = [];
    for (const key of this.USER_TICKETS_CACHE_KEY) {
      if (key.includes(`tickets:user:${userId}:`)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      await this.cacheManager.del(key);
      this.USER_TICKETS_CACHE_KEY.delete(key);
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
  // tạo qr code từ ticket code
  private async generateQRCode(ticketCode: string): Promise<string> {
    try {
      // Tạo data URL (base64) cho QR code
      const qrCodeDataURL = await QRCode.toDataURL(ticketCode, {
        errorCorrectionLevel: "H",
        type: "image/png",
        width: 300,
        margin: 1,
      });
      //  const url = await this.uploadService.uploadQRCode(qrCodeDataURL, ticketCode);
      // return url;
      return qrCodeDataURL;
    } catch (error) {
      console.error("Error generating QR code:", error);
      throw new BadRequestException("Failed to generate QR code");
    }
  }
  async createTicketsFromBooking(
    bookingCode: string,
    session?: ClientSession,
    requesterUserId?: string
  ) {
    const booking = await this.bookingModel
      .findOne({ bookingCode })
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
    const existed = await this.ticketModel
      .exists({
        bookingId: booking._id,
        isDeleted: false,
      })
      .session(session ?? null);

    if (existed) {
      return this.ticketModel
        .find({
          bookingId: booking._id,
          isDeleted: false,
        })
        .session(session ?? null)
        .exec();
    }
    const ticketsData: any[] = [];
    const zone = booking.zoneId as unknown as ZoneSeatMode;

    if (Boolean(zone.hasSeating) && booking.seats?.length) {
      for (const seat of booking.seats) {
        const ticketCode = this.generateTicketCode();
        ticketsData.push({
          bookingId: booking._id,
          eventId: new Types.ObjectId(booking.eventId),
          zoneId: new Types.ObjectId(booking.zoneId),
          areaId: booking.areaId
            ? new Types.ObjectId(booking.areaId)
            : undefined,
          seatNumber: seat,
          status: "valid",
          price: booking.pricePerTicket,
          userId: new Types.ObjectId(booking.userId),
          ticketCode,
        });
      }
    } else {
      for (let i = 0; i < booking.quantity; i++) {
        const ticketCode = this.generateTicketCode();
        ticketsData.push({
          bookingId: booking._id,
          eventId: new Types.ObjectId(booking.eventId),
          zoneId: new Types.ObjectId(booking.zoneId),
          areaId: booking.areaId
            ? new Types.ObjectId(booking.areaId)
            : undefined,
          userId: new Types.ObjectId(booking.userId),
          ticketCode,
          price: booking.pricePerTicket,
          status: "valid",
        });
      }
    }
    const createdTickets = await this.ticketModel.insertMany(ticketsData, {
      session,
    });
    const qrCodes = await Promise.all(
      createdTickets.map((t) => this.generateQRCode(t.ticketCode))
    );
    await this.ticketModel.bulkWrite(
      createdTickets.map((ticket, i) => ({
        updateOne: {
          filter: { _id: ticket._id },
          update: { $set: { qrCode: qrCodes[i] } },
        },
      })),
      { session }
    );

    createdTickets.forEach((ticket, i) => {
      ticket.qrCode = qrCodes[i];
    });

    if (!session) {
      await this.publishTicketCreation(
        booking.bookingCode,
        createdTickets,
        booking.userId?.toString()
      );
    }

    return createdTickets;
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
      .exec();
    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }
    return ticket;
  }

  async validateTicket(
    ticketCode: string,
    requesterUserId: string,
    requesterRole: string
  ) {
    const ticket = await this.ticketModel
      .findOne({ ticketCode, isDeleted: false })
      .populate("eventId", "startDate endDate")
      .exec();
    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    if (
      requesterRole !== "admin" &&
      ticket.userId?.toString() !== requesterUserId
    ) {
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
    const event = ticket.eventId as unknown as TicketEventWindow;
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
    adminId: string
  ) {
    const now = new Date();
    const ticket = await this.ticketModel
      .findOne({ ticketCode, status: "valid", isDeleted: false })
      .populate("eventId", "startDate endDate")
      .exec();

    if (!ticket) {
      throw new BadRequestException(
        "Ticket không hợp lệ hoặc đã được check-in"
      );
    }

    if (!ticket.eventId) {
      throw new BadRequestException("Event not found");
    }
    const event = ticket.eventId as unknown as TicketEventWindow;

    if (now < event.startDate) {
      throw new BadRequestException("Sự kiện chưa bắt đầu, không thể check-in");
    }

    if (now > event.endDate) {
      await this.ticketModel.updateOne(
        { _id: ticket._id },
        { $set: { status: "expired" } }
      );

      throw new BadRequestException("Sự kiện đã kết thúc, vé đã hết hạn");
    }
    const updatedTicket = await this.ticketModel.findOneAndUpdate(
      { _id: ticket._id, status: "valid" },
      {
        $set: {
          status: "used",
          checkedInAt: now,
          checkInLocation: location,
          checkedInBy: new Types.ObjectId(adminId),
          metadata: { deviceInfo, ipAddress },
        },
      },
      { new: true }
    );
    await this.checkInLogModel.create({
      ticketId: ticket._id,
      adminId,
      location,
      deviceInfo,
      ipAddress,
      success: !!updatedTicket,
      message: updatedTicket ? "Check-in success" : "Already used",
    });

    if (!updatedTicket) {
      throw new BadRequestException("Vé đã được check-in bởi thiết bị khác");
    }

    this.ticketGateway.emitTicketCheckedIn({
      ticketCode: updatedTicket.ticketCode,
      eventId: updatedTicket.eventId,
      zoneId: updatedTicket.zoneId,
      seatNumber: updatedTicket.seatNumber || null,
      checkedInAt: updatedTicket.checkedInAt as Date,
    });
    return {
      success: true,
      message: "Ticket checked in successfully",
      ticket: updatedTicket,
    };
  }

  async cancelTicket(ticketCode: string, userId: string) {
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
      { new: true }
    );

    if (!ticket) {
      throw new BadRequestException(
        "Vé đã được sử dụng, đã bị hủy hoặc không tồn tại"
      );
    }
    //  await this.uploadService.deleteQRCode(ticketCode).catch(() => {
    //     // không throw nếu xóa fail, ticket vẫn cancelled
    //     console.error('Failed to delete QR code for ticket:', ticketCode);
    //   });
    await Promise.all([
      this.invalidateTicketCache(),
      this.invalidateUserTicketCache(userId),
    ]);
    return {
      success: true,
      message: "Ticket with code " + ticketCode + " cancelled successfully",
      ticket: {
        ticketCode: ticket.ticketCode,
        seatNumber: ticket.seatNumber,
        zoneId: ticket.zoneId,
        areaId: ticket.areaId || null,
      },
    };
  }

  // admin
  async getAllTickets(
    query: QueryTicketDto
  ): Promise<PaginatedResponse<Ticket>> {
    const cacheKey = this.generateListCacheKey(query);
    const cachedData =
      await this.cacheManager.get<PaginatedResponse<Ticket>>(cacheKey);

    if (cachedData) {
      return cachedData;
    }

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

    const skip = (page - 1) * limit;

    const filter: FilterQuery<Ticket> = { isDeleted: false };

    if (eventId) filter.eventId = new Types.ObjectId(eventId);
    if (zoneId) filter.zoneId = new Types.ObjectId(zoneId);
    if (areaId) filter.areaId = new Types.ObjectId(areaId);
    if (userId) filter.userId = new Types.ObjectId(userId);
    if (status) filter.status = status;

    if (ticketCode) {
      filter.ticketCode = {
        $regex: ticketCode.trim(),
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

    const [tickets, total] = await Promise.all([
      this.ticketModel
        .find(filter)
        .populate("eventId", "title startDate")
        .populate("bookingId", "bookingCode")
        .populate("zoneId", "name")
        .populate("areaId", "name")
        .populate("userId", "email name")
        .populate("checkedInBy", "email name")
        .populate("cancelledBy", "email name")
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean(),

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

    await this.cacheManager.set(cacheKey, result, 30);
    this.TICKETS_CACHE_LIST_KEY.add(cacheKey);

    return result;
  }
  // thống kê vé
  // lấy lịch sử checkin của vé
  async getCheckInHistory(ticketCode: string) {
    const ticket = await this.ticketModel
      .findOne({
        ticketCode,
        isDeleted: false,
      })
      .populate("eventId", "title");

    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    const logs = await this.checkInLogModel
      .find({ ticketId: ticket._id })
      .populate("adminId", "name")
      .sort({ createdAt: -1 })
      .limit(50);

    const event = ticket.eventId as unknown as TicketEventTitle;

    return {
      ticketCode,
      eventTitle: event.title ?? "",
      history: logs,
    };
  }
}
