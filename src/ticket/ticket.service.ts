import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Booking } from '@src/schemas/booking.schema';
import { Ticket } from '@src/schemas/ticket.schema';
import { Model, Types } from 'mongoose';
import { Event } from '@src/schemas/event.schema';
import * as crypto from 'crypto';
import * as QRCode from 'qrcode';
import { BadRequestException } from '@nestjs/common';
import { TicketGateway } from './ticket.gateway';

@Injectable()
export class TicketService {
  constructor(
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
    private ticketGateway: TicketGateway
  ) { }

  // tạo ticket code unique
  private generateTicketCode(): string {
    const timestamp = Date.now().toString().slice(-8);
    const random = crypto.randomBytes(3).toString("hex").toUpperCase();
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
      return qrCodeDataURL;
    } catch (error) {
      console.error("Error generating QR code:", error);
      throw new BadRequestException("Failed to generate QR code");
    }
  }
  async createTicketsFromBooking(bookingCode: string, session?: any) {
    const booking = await this.bookingModel
      .findOne({ bookingCode })
      .populate('zoneId', 'hasSeating')
      .session(session || null)
      .exec();

    if (!booking) {
      throw new BadRequestException('Invalid booking code');
    }
    if (booking.status !== 'confirmed') {
      throw new BadRequestException('Booking is not confirmed');
    }
    const existed = await this.ticketModel.exists({
      bookingId: booking._id,
      isDeleted: false,
    }).session(session || null);

    if (existed) {
      return this.ticketModel.find({
        bookingId: booking._id,
        isDeleted: false,
      }).session(session || null).exec();
    }
    const ticketsData: any[] = [];
    const zone = booking.zoneId as any;

    if (zone.hasSeating && booking.seats?.length) {
      for (const seat of booking.seats) {
        const ticketCode = await this.generateTicketCode();
        ticketsData.push({
          bookingId: booking._id,
          eventId: new Types.ObjectId(booking.eventId),
          zoneId: new Types.ObjectId(booking.zoneId),
          areaId: booking.areaId ? new Types.ObjectId(booking.areaId) : undefined,
          seatNumber: seat,
          status: 'valid',
          price: booking.pricePerTicket,
          userId: new Types.ObjectId(booking.userId),
          ticketCode,
        });
      }
    } else {
      for (let i = 0; i < booking.quantity; i++) {
        const ticketCode = await this.generateTicketCode();
        ticketsData.push({
          bookingId: booking._id,
          eventId: new Types.ObjectId(booking.eventId),
          zoneId: new Types.ObjectId(booking.zoneId),
          areaId: booking.areaId ? new Types.ObjectId(booking.areaId) : undefined,
          userId: new Types.ObjectId(booking.userId),
          ticketCode,
          price: booking.pricePerTicket,
          status: 'valid',
        });

      }
    }
    const createdTickets = await this.ticketModel.insertMany(
      ticketsData,
      { session: session || undefined }
    );
    await Promise.all(
      createdTickets.map(async (ticket) => {
        ticket.qrCode = await this.generateQRCode(ticket.ticketCode);
        return ticket.save({ session: session || undefined });
      })
    );
    this.ticketGateway.emitTicketCreated({
      bookingCode: booking.bookingCode,
      tickets: createdTickets.map(ticket => ({
        ticketCode: ticket.ticketCode,
        eventId: ticket.eventId,
        zoneId: ticket.zoneId,
        seatNumber: ticket.seatNumber || null,
        price: ticket.price,
        status: ticket.status,
      })),
    });
    return createdTickets;
  };

  async getTicketByCode(ticketCode: string) {
    const ticket = await this.ticketModel.findOne({ ticketCode, isDeleted: false })
      .populate('eventId', 'title location startDate endDate')
      .populate('zoneId', 'name')
      .populate('areaId', 'name')
      .exec();
    if (!ticket) {
      throw new BadRequestException('Ticket not found');
    }
    return ticket;
  }

  async validateTicket(ticketCode: string) {
    const ticket = await this.ticketModel.findOne({ ticketCode, isDeleted: false })
      .populate('eventId', 'startDate endDate')
      .exec();
    if (!ticket) {
      throw new BadRequestException('Ticket not found');
    }
    if (ticket.status === 'used') {
      return {
        valid: false,
        message: "Vé đã được sử dụng",
        usedAt: ticket.checkedInAt,
      };
    };
    if (ticket.status === 'cancelled') {
      return {
        valid: false,
        message: "Vé đã bị hủy",
      };
    };
    if (ticket.status === 'expired') {
      return {
        valid: false,
        message: "Vé đã hết hạn",
      }
    };
    const event = await this.eventModel.findById(ticket.eventId).exec();
    if (!event) {
      throw new BadRequestException('Event not found for this ticket');
    }
    const now = new Date();
    if (now < event.startDate) {
      return {
        valid: false,
        message: "Sự kiện chưa bắt đầu, vé chưa thể sử dụng",
      }
    }
    if (now > event.endDate) {
      return {
        valid: false,
        message: "Sự kiện đã kết thúc, vé không còn giá trị sử dụng",
      }
    }

    return {
      valid: true,
      message: "Vé hợp lệ, có thể sử dụng",
      ticket,
    }
  }

  async checkInTicket(
    ticketCode: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    adminId: string,
  ) {
    const ticket = await this.ticketModel.findOneAndUpdate(
      {
        ticketCode,
        status: 'valid',
        isDeleted: false,
      },
      {
        $set: {
          status: 'used',
          checkedInAt: new Date(),
          checkInLocation: location,
          checkedInBy: new Types.ObjectId(adminId),
          metadata: { deviceInfo, ipAddress },
        },
      },
      { new: true }
    );

    if (!ticket) {
      throw new BadRequestException(
        'Ticket không hợp lệ hoặc đã được check-in'
      );
    }

    this.ticketGateway.emitTicketCheckedIn({
      ticketCode: ticket.ticketCode,
      eventId: ticket.eventId,
      zoneId: ticket.zoneId,
      seatNumber: ticket.seatNumber || null,
      checkedInAt: ticket.checkedInAt as Date,
    });

    return {
      success: true,
      message: 'Ticket checked in successfully',
      ticket,
    };
  }

  async cancelTicket(ticketCode: string, userId: string) {
    const ticket = await this.ticketModel.findOneAndUpdate({
      ticketCode,
      status: { $in: ['valid'] },
      isDeleted: false,
    }, {
      $set: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancelledBy: new Types.ObjectId(userId),
      }
    },
      { new: true }
    );

    if (!ticket) {
      throw new BadRequestException(
        'Vé đã được sử dụng, đã bị hủy hoặc không tồn tại'
      );

    }

    return {
      success: true,
      message: 'Ticket with code ' + ticketCode + ' cancelled successfully',
      ticket: {
        ticketCode: ticket.ticketCode,
        seatNumber: ticket.seatNumber,
        zoneId: ticket.zoneId,
        areaId: ticket.areaId || null,
      }
    }
  }


  // admin
  // lấy danh sách vé với filter, pagination
  // thống kê vé
}
