import { Injectable } from "@nestjs/common";
import { CancelBookingDto } from "../dto/cancel-booking.dto";
import { CreateBookingDto } from "../dto/create-booking.dto";
import {
  BookingCreateResult,
  BookingMessageResult,
} from "../domain/types/booking-response.types";
import { BookingMutationService } from "./use-case/booking-mutation.use-case";

@Injectable()
export class BookingCommandService {
  constructor(
    private readonly bookingMutationService: BookingMutationService
  ) {}

  createBooking(
    userId: string,
    data: CreateBookingDto
  ): Promise<BookingCreateResult> {
    return this.bookingMutationService.createBooking(userId, data);
  }

  cancelBooking(
    userId: string,
    dto: CancelBookingDto
  ): Promise<BookingMessageResult> {
    return this.bookingMutationService.cancelBooking(userId, dto);
  }

  adminCancelBooking(
    bookingId: string,
    adminId: string,
    reason?: string
  ): Promise<BookingMessageResult> {
    return this.bookingMutationService.adminCancelBooking(
      bookingId,
      adminId,
      reason
    );
  }
}
