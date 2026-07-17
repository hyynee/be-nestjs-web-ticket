import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";
import { RefundRequest } from "@src/schemas/refund-request.schema";
import { Types } from "mongoose";

export type RefundRequestDocument = RefundRequest & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

export type RefundableBooking = {
  _id: Types.ObjectId;
  bookingCode: string;
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  quantity: number;
  totalPrice: number;
  totalRefunded?: number;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  stripePaymentIntentId?: string;
};
