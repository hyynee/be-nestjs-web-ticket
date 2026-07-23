import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";
import type {
  RefundableBooking,
  RefundRequestDocument,
} from "../types/refund-domain.types";

@Injectable()
export class RefundPolicyService {
  constructor(private readonly eventOwnershipService: EventOwnershipService) {}

  assertRequestOwner(user: JwtPayload, booking: RefundableBooking): void {
    if (booking.userId.toString() !== user.userId) {
      throw new ForbiddenException(
        "You can only request refund for your booking"
      );
    }
  }

  assertViewOwner(user: JwtPayload, request: RefundRequestDocument): void {
    if (request.userId.toString() !== user.userId) {
      throw new ForbiddenException("You can only view your refund requests");
    }
  }

  assertBookingRefundable(booking: RefundableBooking): void {
    if (
      booking.status !== BookingStatus.CONFIRMED ||
      booking.paymentStatus !== PaymentStatus.PAID
    ) {
      throw new BadRequestException(
        "Only confirmed paid bookings can be refunded"
      );
    }
  }

  assertBookingRefundableForReview(booking: RefundableBooking): void {
    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new ConflictException("Booking is no longer confirmed");
    }
    if (
      ![PaymentStatus.PAID, PaymentStatus.REFUND_PENDING].includes(
        booking.paymentStatus
      )
    ) {
      throw new ConflictException("Booking is no longer refundable");
    }
  }

  resolveRefundAmount(
    booking: RefundableBooking,
    requestedAmount: number | undefined
  ): number {
    const refundableAmount = booking.totalPrice - (booking.totalRefunded ?? 0);
    const amount = requestedAmount ?? refundableAmount;
    if (amount <= 0 || amount > refundableAmount) {
      throw new BadRequestException("Invalid refund amount");
    }

    // PayPal captures are settled in USD converted from VND at checkout
    // time (see create-paypal-transaction.use-case.ts); refunding a VND
    // partial amount correctly would require converting it back using the
    // *original* checkout exchange rate, not today's — not implemented.
    // Only Stripe (zero-decimal VND, refunds natively in the same currency)
    // supports a true partial refund today.
    const isPartial = amount < refundableAmount;
    if (isPartial && !booking.stripePaymentIntentId) {
      throw new BadRequestException(
        "Partial refunds are only supported for Stripe payments; this booking can only be refunded in full"
      );
    }

    return amount;
  }

  async assertCanReview(user: JwtPayload, eventId: string): Promise<void> {
    if (!["admin", "organizer"].includes(user.role)) {
      throw new ForbiddenException(
        "You do not have permission to review refunds"
      );
    }
    await this.eventOwnershipService.assertCanManageEvent(user, eventId);
  }
}
