import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isDuplicateKeyError } from "@src/common/utils/mongo.utils";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { RedisService } from "@src/redis/redis.service";
import { TicketQrService } from "@src/ticket/infrastructure/qr/ticket-qr.service";
import { TicketPublisherService } from "@src/ticket/infrastructure/realtime/ticket-publisher.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import { RELEASE_LOCK_SCRIPT } from "@src/ticket/ticket.constants";
import { NotificationService } from "@src/notification/notification.service";
import {
  TicketInsertPayload,
  TicketIssuedItem,
  ZoneSeatMode,
} from "@src/ticket/types/ticket.types";
import * as crypto from "crypto";
import { ClientSession, Model, Types } from "mongoose";

type BookingWithSeatMode = Omit<Booking, "zoneId"> & {
  _id: Types.ObjectId;
  zoneId: ZoneSeatMode;
};

@Injectable()
export class IssueTicketsFromBookingUseCase {
  private readonly logger = new Logger(IssueTicketsFromBookingUseCase.name);

  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly redisService: RedisService,
    private readonly ticketQrService: TicketQrService,
    private readonly ticketPublisher: TicketPublisherService,
    private readonly ticketPresenter: TicketPresenter,
    private readonly notificationService: NotificationService
  ) {}

  async execute(
    bookingCode: string,
    session?: ClientSession,
    requesterUserId?: string
  ): Promise<TicketIssuedItem[]> {
    const normalizedCode = this.normalizeBookingCode(bookingCode);
    const booking = (await this.bookingModel
      .findOne({ bookingCode: normalizedCode, isDeleted: false })
      .populate<{ zoneId: ZoneSeatMode }>("zoneId", "hasSeating")
      .session(session ?? null)
      .exec()) as BookingWithSeatMode | null;

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
        const existing = await this.findExistingTickets(booking._id, session);
        if (existing.length > 0) {
          return existing.map((ticket) =>
            this.ticketPresenter.toTicketIssuedItem(ticket)
          );
        }
        throw new ConflictException(
          "Ticket creation is already in progress for this booking. Please retry in a moment."
        );
      }
      lockAcquired = true;
    }

    try {
      const existingTickets = await this.findExistingTickets(
        booking._id,
        session
      );

      if (existingTickets.length > 0) {
        return existingTickets.map((ticket) =>
          this.ticketPresenter.toTicketIssuedItem(ticket)
        );
      }

      const ticketsData = this.buildTicketPayloads(booking);
      const documentsToInsert = session
        ? ticketsData
        : await Promise.all(
            ticketsData.map(async (data) => ({
              ...data,
              qrCode: await this.ticketQrService.generateQRCode(
                data.ticketCode
              ),
            }))
          );

      let createdTickets: Ticket[];
      try {
        createdTickets = await this.ticketModel.insertMany(documentsToInsert, {
          session,
        });
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          const existing = await this.findExistingTickets(booking._id, session);
          if (existing.length > 0) {
            return existing.map((ticket) =>
              this.ticketPresenter.toTicketIssuedItem(ticket)
            );
          }
        }
        throw err;
      }

      if (!session) {
        await this.ticketPublisher.publishTicketCreation(
          booking.bookingCode,
          createdTickets,
          booking.userId?.toString()
        );
        await this.notificationService.notifyTicketsIssued({
          userId: booking.userId.toString(),
          bookingId: booking._id.toString(),
          bookingCode: booking.bookingCode,
          eventId: booking.eventId.toString(),
        });
      }

      return createdTickets.map((ticket) =>
        this.ticketPresenter.toTicketIssuedItem(ticket)
      );
    } finally {
      if (lockAcquired) {
        await this.redisService.client
          .eval(RELEASE_LOCK_SCRIPT, {
            keys: [lockKey],
            arguments: [lockValue],
          })
          .catch((error: unknown) => {
            this.logger.warn(
              `release ticket creation lock failed for booking ${bookingId}: ${(error as Error)?.message ?? String(error)}`
            );
          });
      }
    }
  }

  private findExistingTickets(
    bookingId: Types.ObjectId,
    session?: ClientSession
  ): Promise<Ticket[]> {
    return this.ticketModel
      .find({ bookingId, isDeleted: false })
      .session(session ?? null)
      .exec();
  }

  private normalizeBookingCode(bookingCode: string): string {
    if (typeof bookingCode !== "string" || !bookingCode.trim()) {
      throw new BadRequestException("Booking code is required");
    }

    return bookingCode.trim().toUpperCase();
  }

  private buildTicketPayloads(
    booking: BookingWithSeatMode
  ): TicketInsertPayload[] {
    const ticketsData: TicketInsertPayload[] = [];
    const zone = booking.zoneId;
    const timeSlotId = booking.timeSlotId
      ? new Types.ObjectId(booking.timeSlotId)
      : undefined;

    if (Boolean(zone.hasSeating) && booking.seats?.length) {
      for (const seat of booking.seats) {
        ticketsData.push(this.buildPayload(booking, zone, timeSlotId, seat));
      }
      return ticketsData;
    }

    for (let i = 0; i < booking.quantity; i++) {
      ticketsData.push(this.buildPayload(booking, zone, timeSlotId));
    }
    return ticketsData;
  }

  private buildPayload(
    booking: BookingWithSeatMode,
    zone: ZoneSeatMode,
    timeSlotId?: Types.ObjectId,
    seatNumber?: string
  ): TicketInsertPayload {
    return {
      bookingId: booking._id as Types.ObjectId,
      eventId: new Types.ObjectId(booking.eventId),
      zoneId: new Types.ObjectId(zone._id),
      areaId: booking.areaId ? new Types.ObjectId(booking.areaId) : undefined,
      timeSlotId,
      seatNumber,
      userId: new Types.ObjectId(booking.userId),
      ticketCode: this.generateTicketCode(),
      price: booking.pricePerTicket,
      status: "valid",
    };
  }

  private generateTicketCode(): string {
    const timestamp = Date.now().toString();
    const random = crypto.randomBytes(6).toString("hex").toUpperCase();
    return `TK${timestamp}${random}`;
  }
}
