import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import {
  AiccSensitiveLookupAccess,
  BookingLookupArgs,
  BookingLookupResult,
  BookingStatusExplanationArgs,
  BookingStatusExplanationResult,
} from "./aicc-tool.types";

interface PopulatedBookingLean {
  _id: Types.ObjectId;
  bookingCode: string;
  status: string;
  paymentStatus: string;
  quantity: number;
  totalPrice: number;
  expiresAt: Date;
  eventId?: {
    _id: Types.ObjectId;
    title: string;
    startDate: Date;
    endDate: Date;
    location: string;
    status?: string;
    thumbnail?: string;
  };
  zoneId?: { _id: Types.ObjectId; name: string; price?: number };
  areaId?: { _id: Types.ObjectId; name: string; rowLabel?: string };
  /** Facts as they were at booking time — preferred over eventId/zoneId/areaId (live, populated) when present. */
  snapshot?: {
    eventTitle: string;
    eventStartDate: Date;
    eventEndDate: Date;
    location: string;
    zoneName: string;
    areaName?: string;
  };
}

@Injectable()
export class AiccBookingTool {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>
  ) {}

  async lookupBooking(args: BookingLookupArgs): Promise<BookingLookupResult> {
    const filter: FilterQuery<Booking> = { isDeleted: false };
    if (!this.applyAccessFilter(filter, args.access)) {
      return { found: false };
    }

    if (args.bookingCode) {
      filter.bookingCode = args.bookingCode.trim().toUpperCase();
    } else if (args.email) {
      filter.customerEmail = args.email.trim().toLowerCase();
    } else if (args.phone) {
      filter.customerPhone = args.phone.trim();
    } else {
      return { found: false };
    }

    const booking = await this.bookingModel
      .findOne(filter)
      .select(
        "bookingCode status paymentStatus quantity totalPrice expiresAt eventId zoneId areaId snapshot"
      )
      .sort({ createdAt: -1 })
      .populate("eventId", "title startDate endDate location thumbnail status")
      .populate("zoneId", "name price")
      .populate("areaId", "name rowLabel")
      .lean<PopulatedBookingLean>()
      .exec();

    if (!booking) {
      return { found: false };
    }

    // Prefer the immutable snapshot (facts as of booking time) for
    // title/dates/location/names — a support conversation about an old
    // booking should reflect what the customer actually booked, not
    // whatever the event/zone/area have since been edited to. `status` and
    // `thumbnail` are intentionally excluded from this preference: they are
    // current-state fields, not historical facts, so they always come from
    // the live populate.
    const snapshot = booking.snapshot;

    return {
      found: true,
      booking: {
        id: booking._id.toString(),
        bookingCode: booking.bookingCode,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        quantity: booking.quantity,
        totalPrice: booking.totalPrice,
        expiresAt: booking.expiresAt.toISOString(),
        event: booking.eventId
          ? {
              id: booking.eventId._id.toString(),
              title: snapshot?.eventTitle ?? booking.eventId.title,
              startDate: (
                snapshot?.eventStartDate ?? booking.eventId.startDate
              ).toISOString(),
              endDate: (
                snapshot?.eventEndDate ?? booking.eventId.endDate
              ).toISOString(),
              location: snapshot?.location ?? booking.eventId.location,
              status: booking.eventId.status ?? "",
              thumbnail: booking.eventId.thumbnail,
            }
          : undefined,
        zone: booking.zoneId
          ? {
              id: booking.zoneId._id.toString(),
              name: snapshot?.zoneName ?? booking.zoneId.name,
              price: booking.zoneId.price,
            }
          : undefined,
        area: booking.areaId
          ? {
              id: booking.areaId._id.toString(),
              name: snapshot?.areaName ?? booking.areaId.name,
              rowLabel: booking.areaId.rowLabel,
            }
          : undefined,
      },
    };
  }

  async explainBookingStatus(
    args: BookingStatusExplanationArgs
  ): Promise<BookingStatusExplanationResult> {
    const result = await this.lookupBooking({
      bookingCode: args.bookingCode,
      access: args.access,
    });
    if (!result.found || !result.booking) {
      return {
        found: false,
        explanation:
          "Mình chưa tìm thấy booking này. Bạn kiểm tra lại mã booking giúp mình nhé.",
        nextAction: "none",
      };
    }

    const booking = result.booking;
    const isExpiredPending =
      booking.status === BookingStatus.PENDING &&
      new Date(booking.expiresAt) < new Date();

    if (booking.status === BookingStatus.CONFIRMED) {
      return {
        found: true,
        bookingCode: booking.bookingCode,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        explanation:
          "Booking đã được xác nhận. Bạn có thể vào mục vé của tôi để xem QR/ticket.",
        nextAction: "view_ticket",
      };
    }

    if (
      booking.status === BookingStatus.PENDING &&
      booking.paymentStatus === PaymentStatus.UNPAID &&
      !isExpiredPending
    ) {
      return {
        found: true,
        bookingCode: booking.bookingCode,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        explanation:
          "Booking đang chờ thanh toán. Bạn nên tiếp tục thanh toán trước khi booking hết hạn.",
        nextAction: "pay_now",
      };
    }

    if (
      booking.status === BookingStatus.PENDING &&
      booking.paymentStatus === PaymentStatus.PAID
    ) {
      return {
        found: true,
        bookingCode: booking.bookingCode,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        explanation:
          "Thanh toán đã được ghi nhận nhưng booking vẫn đang chờ xác nhận. Bạn đợi hệ thống đồng bộ hoặc liên hệ hỗ trợ nếu trạng thái không đổi.",
        nextAction: "wait_payment",
      };
    }

    if (isExpiredPending || booking.status === BookingStatus.EXPIRED) {
      return {
        found: true,
        bookingCode: booking.bookingCode,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        explanation:
          "Booking đã hết hạn nên không thể thanh toán tiếp từ booking này.",
        nextAction: "none",
      };
    }

    if (
      booking.status === BookingStatus.CANCELLED ||
      booking.paymentStatus === PaymentStatus.REFUND_PENDING
    ) {
      return {
        found: true,
        bookingCode: booking.bookingCode,
        status: booking.status,
        paymentStatus: booking.paymentStatus,
        explanation:
          "Booking cần nhân viên kiểm tra thêm vì có trạng thái huỷ hoặc hoàn tiền.",
        nextAction: "contact_support",
      };
    }

    return {
      found: true,
      bookingCode: booking.bookingCode,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      explanation:
        "Booking có trạng thái cần kiểm tra thêm. Mình sẽ chuyển cho nhân viên nếu bạn cần xử lý tiếp.",
      nextAction: "contact_support",
    };
  }

  private applyAccessFilter(
    filter: FilterQuery<Booking>,
    access?: AiccSensitiveLookupAccess
  ): boolean {
    if (access?.userId && Types.ObjectId.isValid(access.userId)) {
      filter.userId = new Types.ObjectId(access.userId);
      return true;
    }

    return false;
  }
}
