import { Injectable } from "@nestjs/common";
import { CancelBookingDto } from "../../dto/cancel-booking.dto";
import { CreateBookingDto } from "../../dto/create-booking.dto";
import {
  BookingCreateResult,
  BookingMessageResult,
} from "../../domain/types/booking-response.types";
import { AdminCancelBookingUseCase } from "./admin-cancel-booking.use-case";
import { CancelBookingUseCase } from "./cancel-booking.use-case";
import { CreateBookingUseCase } from "./create-booking.use-case";

@Injectable()
export class BookingMutationService {
  constructor(
    private readonly createBookingUseCase: CreateBookingUseCase,
    private readonly cancelBookingUseCase: CancelBookingUseCase,
    private readonly adminCancelBookingUseCase: AdminCancelBookingUseCase
  ) {}

  get redisService(): unknown {
    return (this.createBookingUseCase as unknown as { redisService?: unknown })
      .redisService;
  }

  get auditService(): unknown {
    return (
      this.adminCancelBookingUseCase as unknown as { auditService?: unknown }
    ).auditService;
  }

  get uploadService(): unknown {
    return (
      this.adminCancelBookingUseCase as unknown as { uploadService?: unknown }
    ).uploadService;
  }

  createBooking(
    userId: string,
    data: CreateBookingDto
  ): Promise<BookingCreateResult> {
    return this.createBookingUseCase.createBooking(userId, data);
  }

  cancelBooking(
    userId: string,
    dto: CancelBookingDto
  ): Promise<BookingMessageResult> {
    return this.cancelBookingUseCase.cancelBooking(userId, dto);
  }

  adminCancelBooking(
    bookingId: string,
    adminId: string,
    reason?: string
  ): Promise<BookingMessageResult> {
    return this.adminCancelBookingUseCase.adminCancelBooking(
      bookingId,
      adminId,
      reason
    );
  }
}
