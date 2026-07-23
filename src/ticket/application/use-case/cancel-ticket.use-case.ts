import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Zone } from "@src/schemas/zone.schema";
import { TicketCacheService } from "@src/ticket/infrastructure/cache/ticket-cache.service";
import { TicketQrService } from "@src/ticket/infrastructure/qr/ticket-qr.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import { TicketCancelResult } from "@src/ticket/types/ticket.types";
import { ZoneService } from "@src/zone/zone.service";
import { ClientSession, Model, Types } from "mongoose";

@Injectable()
export class CancelTicketUseCase {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    private readonly ticketCache: TicketCacheService,
    private readonly ticketQrService: TicketQrService,
    private readonly ticketPresenter: TicketPresenter,
    private readonly zoneService: ZoneService
  ) {}

  async execute(
    ticketCode: string,
    userId: string
  ): Promise<TicketCancelResult> {
    const dbSession = await this.ticketModel.db.startSession();
    const cancelResult: { cancelledTicket?: Ticket } = {};

    try {
      await dbSession.withTransaction(async () => {
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

        await this.assertBookingAllowsSingleTicketCancellation(
          ticketForCheck.bookingId as Types.ObjectId,
          dbSession
        );

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

        cancelResult.cancelledTicket = ticket;
        await this.restoreZoneInventory(ticket, dbSession);
        await this.cancelBookingWhenNoValidTicketsRemain(ticket, dbSession);
        await this.ticketQrService.deleteQRCode(ticketCode);
      });
    } finally {
      await dbSession.endSession();
    }

    await Promise.all([
      this.ticketCache.invalidateTicketCache(),
      this.ticketCache.invalidateUserTicketCache(userId),
      cancelResult.cancelledTicket?.zoneId
        ? this.zoneService.invalidateZoneAvailabilityCache(
            cancelResult.cancelledTicket.zoneId as Types.ObjectId
          )
        : Promise.resolve(),
    ]);

    if (!cancelResult.cancelledTicket) {
      throw new BadRequestException("Vé không tồn tại hoặc không thể hủy");
    }

    return this.ticketPresenter.ticketCancelResult(
      ticketCode,
      cancelResult.cancelledTicket
    );
  }

  private async assertBookingAllowsSingleTicketCancellation(
    bookingId: Types.ObjectId,
    dbSession: ClientSession
  ): Promise<void> {
    const bookingCheck = await this.bookingModel
      .findById(bookingId)
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
  }

  private async restoreZoneInventory(
    ticket: Ticket,
    dbSession: ClientSession
  ): Promise<void> {
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
  }

  private async cancelBookingWhenNoValidTicketsRemain(
    ticket: Ticket,
    dbSession: ClientSession
  ): Promise<void> {
    const remainingValid = await this.ticketModel.countDocuments(
      { bookingId: ticket.bookingId, status: "valid", isDeleted: false },
      { session: dbSession }
    );
    if (remainingValid !== 0) {
      return;
    }

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
}
