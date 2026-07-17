import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Booking, PaymentStatus } from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { QueueService } from "@src/queue/queue.service";
import { MailService } from "@src/services/mail.service";
import { InvoicePdfService } from "./infrastructure/pdf/invoice-pdf.service";
import type { InvoiceData } from "./types/invoice.types";

type BookingLean = Pick<
  Booking,
  | "bookingCode"
  | "userId"
  | "eventId"
  | "zoneId"
  | "areaId"
  | "seats"
  | "quantity"
  | "pricePerTicket"
  | "totalPrice"
  | "snapshot"
  | "paymentStatus"
  | "customerEmail"
  | "customerName"
  | "paidAt"
  | "totalRefunded"
> & { _id: Types.ObjectId };

type PaymentLean = Pick<
  Payment,
  | "paymentMethod"
  | "status"
  | "stripePaymentIntentId"
  | "paypalOrderId"
  | "currency"
  | "paidAt"
>;

export interface InvoicePdfResult {
  buffer: Buffer;
  filename: string;
}

export interface ResendInvoiceResult {
  status: number;
  message: string;
}

export type InvoiceAccessMode = "owner" | "admin" | "system";

export interface InvoiceAccessOptions {
  accessMode: InvoiceAccessMode;
}

/** Filenames end up in a Content-Disposition header — keep to a safe charset. */
function toSafeFilenamePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

@Injectable()
export class InvoiceService {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    private readonly invoicePdfService: InvoicePdfService,
    private readonly mailService: MailService,
    private readonly queueService: QueueService
  ) {}

  async getInvoicePdf(
    bookingCode: string,
    user: JwtPayload,
    options: InvoiceAccessOptions
  ): Promise<InvoicePdfResult> {
    const booking = await this.loadAccessibleBooking(
      bookingCode,
      user,
      options
    );
    const data = await this.composeInvoiceData(booking);
    const buffer = await this.invoicePdfService.generate(data);
    return {
      buffer,
      filename: `invoice-${toSafeFilenamePart(data.bookingCode)}.pdf`,
    };
  }

  async resendInvoice(
    bookingCode: string,
    user: JwtPayload,
    options: InvoiceAccessOptions
  ): Promise<ResendInvoiceResult> {
    const booking = await this.loadAccessibleBooking(
      bookingCode,
      user,
      options
    );

    await this.queueService.addJob({
      type: "resend-invoice-email",
      payload: { bookingCode: booking.bookingCode },
    });

    return {
      status: 200,
      message: "Hoa don se duoc gui lai qua email trong giay lat.",
    };
  }

  /** Called from the queue processor (system context) — no user/ownership check, only paid-state. */
  async deliverInvoiceEmail(bookingCode: string): Promise<void> {
    const booking = await this.loadAccessibleBooking(bookingCode, undefined, {
      accessMode: "system",
    });
    const data = await this.composeInvoiceData(booking);
    const buffer = await this.invoicePdfService.generate(data);

    await this.mailService.deliverInvoiceEmail({
      to: data.customerEmail,
      customerName: data.customerName,
      bookingCode: data.bookingCode,
      pdfBuffer: buffer,
    });
  }

  private async loadAccessibleBooking(
    bookingCode: string,
    user: JwtPayload | undefined,
    options: InvoiceAccessOptions
  ): Promise<BookingLean> {
    const normalizedCode = bookingCode?.trim().toUpperCase();
    if (!normalizedCode) {
      throw new BadRequestException("Booking code is required");
    }

    const booking = await this.bookingModel
      .findOne({ bookingCode: normalizedCode, isDeleted: false })
      .lean<BookingLean>();

    if (!booking) {
      throw new NotFoundException("Khong tim thay booking");
    }

    if (options.accessMode === "owner") {
      if (!user) {
        throw new ForbiddenException("Unauthorized");
      }
      if (user.role !== "admin" && booking.userId.toString() !== user.userId) {
        throw new ForbiddenException(
          "Ban khong co quyen truy cap hoa don cua booking nay"
        );
      }
    }

    if (!booking.paidAt || booking.paymentStatus === PaymentStatus.UNPAID) {
      throw new BadRequestException("Booking chua thanh toan, chua co hoa don");
    }

    return booking;
  }

  private async composeInvoiceData(booking: BookingLean): Promise<InvoiceData> {
    const payment = await this.paymentModel
      .findOne({ bookingId: booking._id, isDeleted: false })
      .sort({ createdAt: -1 })
      .lean<PaymentLean>();

    const snapshot = booking.snapshot;

    let eventTitle = snapshot?.eventTitle;
    let eventDate: Date | string | undefined = snapshot?.eventStartDate;
    let location = snapshot?.location;
    let zoneName = snapshot?.zoneName;
    let areaName = snapshot?.areaName;
    const unitPrice = snapshot?.pricePerTicket ?? booking.pricePerTicket;
    const currency = snapshot?.currency ?? payment?.currency ?? "vnd";

    if (!snapshot) {
      const [event, zone, area] = await Promise.all([
        this.eventModel
          .findById(booking.eventId)
          .select("title location startDate")
          .lean<{ title: string; location: string; startDate: Date }>(),
        this.zoneModel
          .findById(booking.zoneId)
          .select("name")
          .lean<{ name: string }>(),
        booking.areaId
          ? this.areaModel
              .findById(booking.areaId)
              .select("name")
              .lean<{ name: string }>()
          : Promise.resolve(null),
      ]);

      eventTitle = event?.title ?? "N/A";
      eventDate = event?.startDate;
      location = event?.location ?? "N/A";
      zoneName = zone?.name ?? "N/A";
      areaName = area?.name;
    }

    const subtotal = unitPrice * booking.quantity;
    const discount = Math.max(subtotal - booking.totalPrice, 0);
    const paymentProvider = payment?.stripePaymentIntentId
      ? "stripe"
      : payment?.paypalOrderId
        ? "paypal"
        : undefined;

    return {
      bookingCode: booking.bookingCode,
      customerName: booking.customerName || "Khach hang",
      customerEmail: booking.customerEmail,
      eventTitle: eventTitle ?? "N/A",
      eventDate,
      location: location ?? "N/A",
      zoneName: zoneName ?? "N/A",
      areaName,
      seats: booking.seats ?? [],
      quantity: booking.quantity,
      unitPrice,
      discount,
      totalPrice: booking.totalPrice,
      currency,
      paidAt: booking.paidAt,
      paymentMethod: payment?.paymentMethod,
      paymentProvider,
      paymentStatus: booking.paymentStatus,
      refundedAmount: booking.totalRefunded ?? 0,
    };
  }
}
