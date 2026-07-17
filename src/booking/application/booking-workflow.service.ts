import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { CreateBookingDto } from "../dto/create-booking.dto";
import { QueryBookingDto } from "../dto/query-booking.dto";
import { CancelBookingDto } from "../dto/cancel-booking.dto";
import { BookingCommandService } from "./booking-command.service";
import { BookingQueryService } from "./booking-query.service";
import { BookingMaintenanceService } from "./booking-maintenance.service";
import {
  BookingCreateResult,
  BookingDetailResult,
  BookingListItem,
  BookingListResult,
  BookingMessageResult,
  ExpirePendingBookingsResult,
  ZoneBookingInfoResult,
} from "../domain/types/booking-response.types";

export type {
  BookingCreateResult,
  BookingDetailResult,
  BookingListItem,
  BookingListResult,
  BookingMessageResult,
  BookingReferenceView,
  ExpirePendingBookingsResult,
  ZoneBookingAreaView,
  ZoneBookingEventView,
  ZoneBookingInfoResult,
  ZoneBookingZoneView,
} from "../domain/types/booking-response.types";

@Injectable()
export class BookingWorkflowService {
  constructor(
    private readonly bookingCommandService: BookingCommandService,
    private readonly bookingQueryService: BookingQueryService,
    private readonly bookingMaintenanceService: BookingMaintenanceService
  ) {}

  createBooking(
    userId: string,
    data: CreateBookingDto
  ): Promise<BookingCreateResult> {
    return this.bookingCommandService.createBooking(userId, data);
  }

  getMyBookings(
    userId: string,
    status?: string,
    page?: number,
    limit?: number
  ): Promise<BookingListResult> {
    return this.bookingQueryService.getMyBookings(userId, status, page, limit);
  }

  getBookingByCode(
    userId: string,
    bookingCode: string
  ): Promise<BookingDetailResult> {
    return this.bookingQueryService.getBookingByCode(userId, bookingCode);
  }

  getZoneBookingInfo(
    eventId: string,
    zoneId: string
  ): Promise<ZoneBookingInfoResult> {
    return this.bookingQueryService.getZoneBookingInfo(eventId, zoneId);
  }

  cancelBooking(
    userId: string,
    dto: CancelBookingDto
  ): Promise<BookingMessageResult> {
    return this.bookingCommandService.cancelBooking(userId, dto);
  }

  adminCancelBooking(
    bookingId: string,
    adminId: string,
    reason?: string
  ): Promise<BookingMessageResult> {
    return this.bookingCommandService.adminCancelBooking(
      bookingId,
      adminId,
      reason
    );
  }

  getAllBookings(
    query: QueryBookingDto,
    currentUser: JwtPayload
  ): Promise<PaginatedResponse<BookingListItem>> {
    return this.bookingQueryService.getAllBookings(query, currentUser);
  }

  expirePendingBookings(): Promise<ExpirePendingBookingsResult> {
    return this.bookingMaintenanceService.expirePendingBookings();
  }

  cleanupOldBookings(before: Date): Promise<void> {
    return this.bookingMaintenanceService.cleanupOldBookings(before);
  }
}
