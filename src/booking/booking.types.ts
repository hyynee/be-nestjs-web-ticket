import { Types } from "mongoose";
import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";

export interface BookingCreatePayload {
  userId: Types.ObjectId;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  areaId?: Types.ObjectId;
  timeSlotId?: Types.ObjectId;
  seats: string[];
  quantity: number;
  pricePerTicket: number;
  totalPrice: number;
  bookingCode: string;
  expiresAt: Date;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
}

export interface BookingCreateResult {
  success: true;
  message: string;
  data: { bookingCode: string; [key: string]: unknown };
}

export interface SlotCapacityInfo {
  label: string;
  capacity: number;
  counterKey: string;
}
