import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Types } from "mongoose";

export type BookingReference =
  Types.ObjectId | string | null | Record<string, unknown>;

export interface BookingSnapshotSource {
  snapshot?: Booking["snapshot"];
  eventId?: BookingReference;
  zoneId?: BookingReference;
  areaId?: BookingReference;
}

export interface BookingViewSource extends BookingSnapshotSource {
  _id?: Types.ObjectId | string;
  id?: string;
  bookingCode: string;
  userId?: BookingReference;
  timeSlotId?: Types.ObjectId | string;
  seats?: string[];
  quantity: number;
  pricePerTicket: number;
  originalTotalPrice?: number;
  discountAmount?: number;
  promotionCode?: string;
  promotionId?: Types.ObjectId | string;
  totalPrice: number;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  expiresAt: Date;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  paidAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  totalRefunded?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BookingReferenceView {
  id?: string;
  title?: string;
  name?: string;
  email?: string;
  startDate?: Date;
  endDate?: Date;
  location?: string;
  thumbnail?: string;
  price?: number;
  hasSeating?: boolean;
  rowLabel?: string;
}

export interface BookingListItem {
  id: string;
  bookingCode: string;
  user?: BookingReferenceView;
  event?: BookingReferenceView;
  zone?: BookingReferenceView;
  area?: BookingReferenceView;
  timeSlotId?: string;
  seats: string[];
  quantity: number;
  pricePerTicket: number;
  originalTotalPrice: number;
  discountAmount: number;
  promotionCode?: string;
  promotionId?: string;
  totalPrice: number;
  status: BookingStatus;
  paymentStatus: PaymentStatus;
  expiresAt: Date;
  customerEmail: string;
  customerName?: string;
  customerPhone?: string;
  notes?: string;
  paidAt?: Date;
  cancelledAt?: Date;
  cancellationReason?: string;
  totalRefunded: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface BookingMessageResult {
  message: string;
}

export interface BookingCreateResult {
  success: true;
  message: string;
  data: BookingListItem;
}

export interface BookingDetailResult {
  success: true;
  data: BookingListItem;
}

export interface BookingListResult {
  success: boolean;
  items: BookingListItem[];
  meta: PaginatedResponse<BookingListItem>["meta"];
}

export interface ZoneBookingEventView {
  _id: Types.ObjectId | string;
  title: string;
  startDate: Date;
  endDate: Date;
  location: string;
}

export interface ZoneBookingZoneView {
  _id: Types.ObjectId | string;
  name: string;
  price: number;
  hasSeating: boolean;
  capacity: number;
  soldCount: number;
  availableTickets: number;
  saleStartDate?: Date;
  saleEndDate?: Date;
}

export interface ZoneBookingAreaView {
  _id: Types.ObjectId | string;
  name: string;
  description?: string;
  rowLabel?: string;
  seatCount?: number;
}

export interface ZoneBookingInfoResult {
  success: boolean;
  data: {
    event: ZoneBookingEventView;
    zone: ZoneBookingZoneView;
    areas: ZoneBookingAreaView[] | null;
    bookedSeatsByArea: Record<string, string[]> | null;
  };
}

export interface ExpirePendingBookingsResult {
  success: boolean;
  message: string;
  expired: number;
}
