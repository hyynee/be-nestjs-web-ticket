import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Booking } from "@src/schemas/booking.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { TicketQrService } from "@src/ticket/infrastructure/qr/ticket-qr.service";
import { TicketPublisherService } from "@src/ticket/infrastructure/realtime/ticket-publisher.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import { TicketIssuedItem } from "@src/ticket/types/ticket.types";
import { Model } from "mongoose";

@Injectable()
export class GenerateMissingQRCodesUseCase {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    private readonly ticketQrService: TicketQrService,
    private readonly ticketPublisher: TicketPublisherService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(bookingCode: string): Promise<TicketIssuedItem[]> {
    const normalizedCode = this.normalizeBookingCode(bookingCode);
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
      return tickets.map((ticket) =>
        this.ticketPresenter.toTicketIssuedItem(ticket)
      );
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
              qrCode: await this.ticketQrService.generateQRCode(
                ticket.ticketCode
              ),
            },
          },
        },
      }))
    );

    await this.ticketModel.bulkWrite(updates);

    const refreshedTickets = await this.ticketModel
      .find({ bookingId: booking._id, isDeleted: false })
      .exec();

    await this.ticketPublisher.publishTicketCreation(
      normalizedCode,
      refreshedTickets,
      booking.userId?.toString()
    );

    return refreshedTickets.map((ticket) =>
      this.ticketPresenter.toTicketIssuedItem(ticket)
    );
  }

  private normalizeBookingCode(bookingCode: string): string {
    if (typeof bookingCode !== "string" || !bookingCode.trim()) {
      throw new BadRequestException("Booking code is required");
    }

    return bookingCode.trim().toUpperCase();
  }
}
