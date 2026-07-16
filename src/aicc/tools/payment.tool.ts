import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { Booking } from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import {
  AiccSensitiveLookupAccess,
  PaymentLookupArgs,
  PaymentLookupResult,
  PaymentStatusExplanationArgs,
  PaymentStatusExplanationResult,
} from "./aicc-tool.types";

interface PaymentLean {
  _id: Types.ObjectId;
  bookingId: Types.ObjectId;
  status: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  paidAt?: Date;
  refundedAt?: Date;
  errorMessage?: string;
  metadata?: { bookingCode?: string };
}

@Injectable()
export class AiccPaymentTool {
  constructor(
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>
  ) {}

  async lookupPayment(args: PaymentLookupArgs): Promise<PaymentLookupResult> {
    const filter: FilterQuery<Payment> = { isDeleted: false };
    if (!this.hasAccess(args.access)) {
      return { found: false };
    }

    if (args.paymentIntentId) {
      filter.stripePaymentIntentId = args.paymentIntentId.trim();
    } else if (args.paypalOrderId) {
      filter.paypalOrderId = args.paypalOrderId.trim();
    } else if (args.bookingId && Types.ObjectId.isValid(args.bookingId)) {
      filter.bookingId = new Types.ObjectId(args.bookingId);
    } else if (args.bookingCode) {
      const booking = await this.bookingModel
        .findOne({
          bookingCode: args.bookingCode.trim().toUpperCase(),
          isDeleted: false,
          ...this.buildBookingAccessFilter(args.access),
        })
        .select("_id")
        .lean<{ _id: Types.ObjectId }>()
        .exec();
      if (!booking) {
        return { found: false };
      }
      filter.bookingId = booking._id;
    } else {
      return { found: false };
    }

    const payment = await this.paymentModel
      .findOne(filter)
      .select(
        "bookingId status amount currency paymentMethod paidAt refundedAt errorMessage metadata"
      )
      .sort({ createdAt: -1 })
      .lean<PaymentLean>()
      .exec();

    if (!payment) {
      return { found: false };
    }

    const bookingAccessFilter = this.buildBookingAccessFilter(args.access);
    const booking = await this.bookingModel
      .findOne({
        _id: payment.bookingId,
        isDeleted: false,
        ...bookingAccessFilter,
      })
      .select("_id")
      .lean()
      .exec();
    if (!booking) {
      return { found: false };
    }

    return {
      found: true,
      payment: {
        id: payment._id.toString(),
        status: payment.status,
        amount: payment.amount,
        currency: payment.currency,
        paymentMethod: payment.paymentMethod,
        paidAt: payment.paidAt?.toISOString(),
        refundedAt: payment.refundedAt?.toISOString(),
        errorMessage: payment.errorMessage,
        bookingCode: payment.metadata?.bookingCode,
      },
    };
  }

  async explainPaymentStatus(
    args: PaymentStatusExplanationArgs
  ): Promise<PaymentStatusExplanationResult> {
    const result = await this.lookupPayment(args);
    if (!result.found || !result.payment) {
      return {
        found: false,
        explanation:
          "Mình chưa tìm thấy giao dịch thanh toán tương ứng. Bạn gửi mã booking hoặc mã giao dịch để mình kiểm tra tiếp nhé.",
        shouldHandoff: false,
      };
    }

    const payment = result.payment;
    if (payment.status === "succeeded") {
      return {
        found: true,
        status: payment.status,
        explanation:
          "Thanh toán đã thành công. Nếu bạn chưa thấy vé, hãy kiểm tra mục vé của tôi hoặc email đã đặt vé.",
        shouldHandoff: false,
      };
    }

    if (payment.status === "pending" || payment.status === "processing") {
      return {
        found: true,
        status: payment.status,
        explanation:
          "Thanh toán đang được xử lý. Bạn nên đợi hệ thống đồng bộ, không thanh toán lặp lại ngay nếu tiền đã bị trừ.",
        shouldHandoff: false,
      };
    }

    if (payment.status === "failed" || payment.status === "canceled") {
      return {
        found: true,
        status: payment.status,
        explanation:
          "Thanh toán chưa hoàn tất. Nếu tài khoản đã bị trừ tiền hoặc bạn không rõ lý do lỗi, cần nhân viên kiểm tra.",
        shouldHandoff: true,
        handoffReason: "payment_issue",
      };
    }

    if (
      payment.status === "refunded" ||
      payment.status === "partially_refunded"
    ) {
      return {
        found: true,
        status: payment.status,
        explanation:
          "Giao dịch có trạng thái hoàn tiền. Các câu hỏi chi tiết về refund cần nhân viên kiểm tra hồ sơ thanh toán.",
        shouldHandoff: true,
        handoffReason: "refund",
      };
    }

    return {
      found: true,
      status: payment.status,
      explanation:
        "Giao dịch có trạng thái cần kiểm tra thêm. Mình sẽ chuyển cho nhân viên nếu bạn cần xử lý tiếp.",
      shouldHandoff: true,
      handoffReason: "payment_issue",
    };
  }

  private hasAccess(access?: AiccSensitiveLookupAccess): boolean {
    return Boolean(access?.userId && Types.ObjectId.isValid(access.userId));
  }

  private buildBookingAccessFilter(
    access?: AiccSensitiveLookupAccess
  ): FilterQuery<Booking> {
    if (access?.userId && Types.ObjectId.isValid(access.userId)) {
      return { userId: new Types.ObjectId(access.userId) };
    }
    return { _id: { $exists: false } };
  }
}
