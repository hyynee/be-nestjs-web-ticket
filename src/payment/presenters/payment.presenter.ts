import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import type {
  CheckoutSessionResult,
  PaymentCancelResult,
  PaymentHistoryBookingSource,
  PaymentHistoryEvent,
  PaymentHistoryItem,
  PaymentHistoryResult,
  PaymentHistorySource,
  PaymentHistoryZone,
  PaypalCreateTransactionResult,
  PaypalFinalizeResult,
} from "@src/payment/types/payment.types";

@Injectable()
export class PaymentPresenter {
  checkoutSessionResult(
    message: string,
    checkoutUrl: string | null
  ): CheckoutSessionResult {
    return {
      status: 200,
      message,
      checkoutUrl,
    };
  }

  paypalCreateTransactionResult(input: {
    paypalOrderId: string;
    approvalUrl?: string;
    amountUSD: string;
    bookingCode: string;
    amount: number;
    customerEmail?: string;
    customerName?: string;
    customerPhone?: string;
  }): PaypalCreateTransactionResult {
    return {
      status: 200,
      message: "PayPal order created successfully",
      paypalOrderId: input.paypalOrderId,
      approvalUrl: input.approvalUrl,
      amountUSD: input.amountUSD,
      bookingDetails: {
        bookingCode: input.bookingCode,
        amount: input.amount,
        amountUSD: input.amountUSD,
        currency: "VND",
        customerEmail: input.customerEmail,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
      },
    };
  }

  paypalFinalizeResult(
    message: string,
    captureId?: string
  ): PaypalFinalizeResult {
    return {
      status: 200,
      message,
      ...(captureId ? { captureId } : {}),
    };
  }

  paymentCancelResult(message: string): PaymentCancelResult {
    return {
      status: 200,
      message,
    };
  }

  paymentHistoryResult(input: {
    payments: PaymentHistorySource[];
    currentPage: number;
    itemsPerPage: number;
    totalItems: number;
  }): PaymentHistoryResult {
    const totalPages = Math.ceil(input.totalItems / input.itemsPerPage);
    return {
      success: true,
      data: input.payments.map((payment) => this.toPaymentHistoryItem(payment)),
      meta: {
        currentPage: input.currentPage,
        itemsPerPage: input.itemsPerPage,
        totalItems: input.totalItems,
        totalPages,
        hasPreviousPage: input.currentPage > 1,
        hasNextPage: input.currentPage < totalPages,
      },
    };
  }

  private toPaymentHistoryItem(
    payment: PaymentHistorySource
  ): PaymentHistoryItem {
    return {
      id: this.toOptionalId(payment._id) ?? "",
      booking: this.toPaymentHistoryBooking(payment.bookingId),
      amount: payment.amount,
      currency: payment.currency,
      paymentMethod: payment.paymentMethod,
      status: payment.status,
      errorMessage: payment.errorMessage,
      stripePaymentIntentId: payment.stripePaymentIntentId,
      paypalOrderId: payment.paypalOrderId,
      paypalCaptureId: payment.paypalCaptureId,
      metadata: payment.metadata,
      paidAt: payment.paidAt,
      refundedAt: payment.refundedAt,
      stripeRefundId: payment.stripeRefundId,
      refundAmount: payment.refundAmount,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }

  private toPaymentHistoryBooking(
    booking: PaymentHistorySource["bookingId"]
  ): PaymentHistoryItem["booking"] {
    if (!booking) {
      return "";
    }

    if (booking instanceof Types.ObjectId || typeof booking === "string") {
      return booking.toString();
    }

    return {
      id: this.toOptionalId(booking._id),
      bookingCode: booking.bookingCode,
      event: this.toPaymentHistoryEvent(booking.eventId),
      zone: this.toPaymentHistoryZone(booking.zoneId),
    };
  }

  private toPaymentHistoryEvent(
    event?: PaymentHistoryBookingSource["eventId"]
  ): PaymentHistoryEvent | undefined {
    if (
      !event ||
      event instanceof Types.ObjectId ||
      typeof event === "string"
    ) {
      return undefined;
    }

    return {
      id: this.toOptionalId(event._id),
      title: event.title,
      location: event.location,
      startDate: event.startDate,
    };
  }

  private toPaymentHistoryZone(
    zone?: PaymentHistoryBookingSource["zoneId"]
  ): PaymentHistoryZone | undefined {
    if (!zone || zone instanceof Types.ObjectId || typeof zone === "string") {
      return undefined;
    }

    return {
      id: this.toOptionalId(zone._id),
      name: zone.name,
      price: zone.price,
    };
  }

  private toOptionalId(value?: Types.ObjectId | string): string | undefined {
    return value?.toString();
  }
}
