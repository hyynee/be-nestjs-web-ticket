import { BadRequestException, Injectable } from "@nestjs/common";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { Types } from "mongoose";
import {
  BookingDetailResult,
  BookingListItem,
  BookingMessageResult,
  BookingReference,
  BookingReferenceView,
  BookingSnapshotSource,
  BookingViewSource,
  ExpirePendingBookingsResult,
} from "../domain/types/booking-response.types";

@Injectable()
export class BookingPresenter {
  toBookingListItem(booking: BookingViewSource): BookingListItem {
    const historicalBooking = this.applyBookingSnapshot(booking);

    return {
      id: this.getBookingId(historicalBooking),
      bookingCode: historicalBooking.bookingCode,
      user: this.toBookingReference(historicalBooking.userId),
      event: this.toBookingReference(historicalBooking.eventId),
      zone: this.toBookingReference(historicalBooking.zoneId),
      area: this.toBookingReference(historicalBooking.areaId),
      timeSlotId: historicalBooking.timeSlotId?.toString(),
      seats: historicalBooking.seats ?? [],
      quantity: historicalBooking.quantity,
      pricePerTicket: historicalBooking.pricePerTicket,
      totalPrice: historicalBooking.totalPrice,
      status: historicalBooking.status,
      paymentStatus: historicalBooking.paymentStatus,
      expiresAt: historicalBooking.expiresAt,
      customerEmail: historicalBooking.customerEmail,
      customerName: historicalBooking.customerName,
      customerPhone: historicalBooking.customerPhone,
      notes: historicalBooking.notes,
      paidAt: historicalBooking.paidAt,
      cancelledAt: historicalBooking.cancelledAt,
      cancellationReason: historicalBooking.cancellationReason,
      totalRefunded: historicalBooking.totalRefunded ?? 0,
      createdAt: historicalBooking.createdAt,
      updatedAt: historicalBooking.updatedAt,
    };
  }

  bookingMessage(message: string): BookingMessageResult {
    return { message };
  }

  bookingDetail(booking: BookingViewSource): BookingDetailResult {
    return {
      success: true,
      data: this.toBookingListItem(booking),
    };
  }

  bookingPage(
    bookings: BookingViewSource[],
    page: number,
    limit: number,
    total: number
  ): PaginatedResponse<BookingListItem> {
    const totalPages = Math.ceil(total / limit);
    return {
      items: bookings.map((booking) => this.toBookingListItem(booking)),
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  expireResult(message: string, expired: number): ExpirePendingBookingsResult {
    return {
      success: true,
      message,
      expired,
    };
  }

  private toPlainBookingSource<TBooking extends BookingSnapshotSource>(
    booking: TBooking
  ): TBooking {
    const serializable = booking as TBooking & { toObject?: () => TBooking };
    return typeof serializable.toObject === "function"
      ? serializable.toObject()
      : booking;
  }

  private applyBookingSnapshot<TBooking extends BookingSnapshotSource>(
    booking: TBooking
  ): TBooking {
    const plainBooking = this.toPlainBookingSource(booking);
    const snapshot = plainBooking?.snapshot;
    if (!snapshot) return booking;

    const eventId =
      plainBooking.eventId &&
      typeof plainBooking.eventId === "object" &&
      !(plainBooking.eventId instanceof Types.ObjectId)
        ? {
            ...plainBooking.eventId,
            title: snapshot.eventTitle,
            location: snapshot.location,
            startDate: snapshot.eventStartDate,
            endDate: snapshot.eventEndDate,
          }
        : {
            id: plainBooking.eventId?.toString(),
            title: snapshot.eventTitle,
            location: snapshot.location,
            startDate: snapshot.eventStartDate,
            endDate: snapshot.eventEndDate,
          };

    const zoneId =
      plainBooking.zoneId &&
      typeof plainBooking.zoneId === "object" &&
      !(plainBooking.zoneId instanceof Types.ObjectId)
        ? { ...plainBooking.zoneId, name: snapshot.zoneName }
        : { id: plainBooking.zoneId?.toString(), name: snapshot.zoneName };

    const areaId = snapshot.areaName
      ? plainBooking.areaId &&
        typeof plainBooking.areaId === "object" &&
        !(plainBooking.areaId instanceof Types.ObjectId)
        ? { ...plainBooking.areaId, name: snapshot.areaName }
        : { id: plainBooking.areaId?.toString(), name: snapshot.areaName }
      : plainBooking.areaId;

    return {
      ...plainBooking,
      eventId,
      zoneId,
      areaId,
    };
  }

  private getBookingId(booking: BookingViewSource): string {
    const id = booking._id?.toString() ?? booking.id;
    if (!id) {
      throw new BadRequestException("Booking ID is missing");
    }
    return id;
  }

  private toBookingReference(
    value: BookingReference | undefined
  ): BookingReferenceView | undefined {
    if (!value) {
      return undefined;
    }

    if (typeof value === "string" || value instanceof Types.ObjectId) {
      return { id: value.toString() };
    }

    const id =
      value._id instanceof Types.ObjectId || typeof value._id === "string"
        ? value._id.toString()
        : typeof value.id === "string"
          ? value.id
          : undefined;

    return {
      id,
      title: typeof value.title === "string" ? value.title : undefined,
      name: typeof value.name === "string" ? value.name : undefined,
      email: typeof value.email === "string" ? value.email : undefined,
      startDate: value.startDate instanceof Date ? value.startDate : undefined,
      endDate: value.endDate instanceof Date ? value.endDate : undefined,
      location: typeof value.location === "string" ? value.location : undefined,
      thumbnail:
        typeof value.thumbnail === "string" ? value.thumbnail : undefined,
      price: typeof value.price === "number" ? value.price : undefined,
      hasSeating:
        typeof value.hasSeating === "boolean" ? value.hasSeating : undefined,
      rowLabel: typeof value.rowLabel === "string" ? value.rowLabel : undefined,
    };
  }
}
