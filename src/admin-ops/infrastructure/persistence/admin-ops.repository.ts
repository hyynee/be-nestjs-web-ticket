import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import {
  Notification,
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from "@src/schemas/notification.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import {
  ANOMALY_TYPE_CAP,
  BOOKING_PENDING_GRACE_MINUTES,
} from "@src/admin-ops/admin-ops.constants";

export interface TicketMissingQrRow {
  ticketId: string;
  ticketCode: string;
  bookingId: string;
  eventId: string;
  detectedAt: Date;
}

export interface PaymentEmailFailedRow {
  notificationId: string;
  bookingCode?: string;
  errorMessage?: string;
  detectedAt: Date;
}

export interface BookingPendingPastExpiryRow {
  bookingId: string;
  bookingCode: string;
  eventId: string;
  expiresAt: Date;
  detectedAt: Date;
}

export interface BookingForResend {
  _id: Types.ObjectId;
  bookingCode: string;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  seats: string[];
  quantity: number;
  totalPrice: number;
  customerEmail: string;
  customerName?: string;
  status: BookingStatus;
  snapshot?: {
    eventTitle: string;
    eventStartDate: Date;
    location: string;
    zoneName: string;
    currency: string;
  };
}

@Injectable()
export class AdminOpsRepository {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>
  ) {}

  async countPendingBookings(): Promise<number> {
    return this.bookingModel.countDocuments({
      status: BookingStatus.PENDING,
      isDeleted: false,
    });
  }

  async countPendingBookingsPastExpiry(): Promise<number> {
    return this.bookingModel.countDocuments(this.pendingPastExpiryFilter());
  }

  async countTicketsMissingQr(): Promise<number> {
    return this.ticketModel.countDocuments(this.missingQrFilter());
  }

  async queryTicketsMissingQr(): Promise<TicketMissingQrRow[]> {
    const rows = await this.ticketModel
      .find(this.missingQrFilter())
      .select("ticketCode bookingId eventId createdAt")
      .sort({ createdAt: -1 })
      .limit(ANOMALY_TYPE_CAP)
      .lean<
        {
          _id: Types.ObjectId;
          ticketCode: string;
          bookingId: Types.ObjectId;
          eventId: Types.ObjectId;
          createdAt: Date;
        }[]
      >();

    return rows.map((row) => ({
      ticketId: row._id.toString(),
      ticketCode: row.ticketCode,
      bookingId: row.bookingId.toString(),
      eventId: row.eventId.toString(),
      detectedAt: row.createdAt,
    }));
  }

  async queryPaymentSucceededEmailFailed(): Promise<PaymentEmailFailedRow[]> {
    const rows = await this.notificationModel
      .find({
        type: NotificationType.PAYMENT_SUCCEEDED,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.FAILED,
      })
      .select("metadata errorMessage createdAt")
      .sort({ createdAt: -1 })
      .limit(ANOMALY_TYPE_CAP)
      .lean<
        {
          _id: Types.ObjectId;
          metadata?: { bookingCode?: string };
          errorMessage?: string;
          createdAt: Date;
        }[]
      >();

    return rows.map((row) => ({
      notificationId: row._id.toString(),
      bookingCode: row.metadata?.bookingCode,
      errorMessage: row.errorMessage,
      detectedAt: row.createdAt,
    }));
  }

  async queryBookingsPendingPastExpiry(): Promise<
    BookingPendingPastExpiryRow[]
  > {
    const rows = await this.bookingModel
      .find(this.pendingPastExpiryFilter())
      .select("bookingCode eventId expiresAt")
      .sort({ expiresAt: 1 })
      .limit(ANOMALY_TYPE_CAP)
      .lean<
        {
          _id: Types.ObjectId;
          bookingCode: string;
          eventId: Types.ObjectId;
          expiresAt: Date;
        }[]
      >();

    return rows.map((row) => ({
      bookingId: row._id.toString(),
      bookingCode: row.bookingCode,
      eventId: row.eventId.toString(),
      expiresAt: row.expiresAt,
      detectedAt: row.expiresAt,
    }));
  }

  async loadBookingForResend(
    normalizedBookingCode: string
  ): Promise<BookingForResend | null> {
    return this.bookingModel
      .findOne({ bookingCode: normalizedBookingCode, isDeleted: false })
      .select(
        "bookingCode userId eventId zoneId seats quantity totalPrice customerEmail customerName status snapshot"
      )
      .lean<BookingForResend>();
  }

  private missingQrFilter(): FilterQuery<Ticket> {
    return {
      status: { $in: ["valid", "used"] },
      isDeleted: false,
      $or: [{ qrCode: { $exists: false } }, { qrCode: "" }],
    };
  }

  private pendingPastExpiryFilter(): FilterQuery<Booking> {
    const graceBoundary = new Date(
      Date.now() - BOOKING_PENDING_GRACE_MINUTES * 60 * 1000
    );
    return {
      status: BookingStatus.PENDING,
      isDeleted: false,
      expiresAt: { $lt: graceBoundary },
      paymentStatus: PaymentStatus.UNPAID,
    };
  }
}
