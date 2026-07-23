import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { NotificationService } from "@src/notification/notification.service";
import { BookingStatus } from "@src/schemas/booking.schema";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import type { BookingConfirmationData } from "@src/types/booking-modules";
import { AdminOpsRepository } from "@src/admin-ops/infrastructure/persistence/admin-ops.repository";
import { ResendConfirmationResult } from "@src/admin-ops/domain/types/admin-ops.types";

@Injectable()
export class ResendConfirmationUseCase {
  constructor(
    private readonly adminOpsRepository: AdminOpsRepository,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly notificationService: NotificationService,
    private readonly auditService: AuditService
  ) {}

  async execute(
    bookingCode: string,
    admin: JwtPayload
  ): Promise<ResendConfirmationResult> {
    const normalizedCode = this.normalizeBookingCode(bookingCode);
    const booking =
      await this.adminOpsRepository.loadBookingForResend(normalizedCode);

    if (!booking) {
      throw new NotFoundException("Booking not found");
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException(
        "Booking is not confirmed; nothing to resend"
      );
    }

    if (!booking.snapshot) {
      throw new BadRequestException(
        "This booking has no snapshot data (legacy booking); resend-confirmation is not supported for it"
      );
    }

    const tickets = await this.ticketModel
      .find({ bookingId: booking._id, isDeleted: false })
      .select("ticketCode seatNumber qrCode")
      .lean<{ ticketCode: string; seatNumber?: string; qrCode?: string }[]>();

    const payload: BookingConfirmationData = {
      email: booking.customerEmail,
      customerName: booking.customerName ?? "Khách hàng",
      bookingCode: booking.bookingCode,
      eventTitle: booking.snapshot.eventTitle,
      eventLocation: booking.snapshot.location,
      eventDate: booking.snapshot.eventStartDate,
      zoneName: booking.snapshot.zoneName,
      seats: booking.seats,
      quantity: booking.quantity,
      totalPrice: booking.totalPrice,
      currency: booking.snapshot.currency,
      tickets: tickets.map((ticket) => ({
        ticketCode: ticket.ticketCode,
        seatNumber: ticket.seatNumber,
        qrCode: ticket.qrCode ?? "",
      })),
    };

    await this.notificationService.resendBookingConfirmationEmail(
      payload,
      booking.userId.toString()
    );

    await this.auditService.record({
      action: AuditAction.ADMIN_BOOKING_RESEND_CONFIRMATION,
      actorId: admin.userId,
      actorRole: admin.role,
      bookingId: booking._id.toString(),
      eventId: booking.eventId.toString(),
      reason: `Admin resent confirmation email for booking ${booking.bookingCode}`,
      metadata: { bookingCode: booking.bookingCode },
    });

    return { bookingCode: booking.bookingCode, status: "queued" };
  }

  private normalizeBookingCode(bookingCode: string): string {
    if (typeof bookingCode !== "string" || !bookingCode.trim()) {
      throw new BadRequestException("Booking code is required");
    }

    return bookingCode.trim().toUpperCase();
  }
}
