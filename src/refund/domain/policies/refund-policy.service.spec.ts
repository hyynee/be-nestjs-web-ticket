import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BookingStatus, PaymentStatus } from "@src/schemas/booking.schema";
import { RefundableBooking } from "../types/refund-domain.types";
import { RefundPolicyService } from "./refund-policy.service";

const owner: JwtPayload = { userId: "user-1", role: "user", iat: 0, exp: 0 };
const stranger: JwtPayload = {
  userId: "user-2",
  role: "user",
  iat: 0,
  exp: 0,
};
const admin: JwtPayload = { userId: "admin-1", role: "admin", iat: 0, exp: 0 };
const organizer: JwtPayload = {
  userId: "org-1",
  role: "organizer",
  iat: 0,
  exp: 0,
};

function makeBooking(
  overrides: Partial<RefundableBooking> = {}
): RefundableBooking {
  return {
    _id: new Types.ObjectId(),
    bookingCode: "BK1",
    userId: new Types.ObjectId("507f1f77bcf86cd799439011"),
    eventId: new Types.ObjectId(),
    zoneId: new Types.ObjectId(),
    quantity: 2,
    totalPrice: 100000,
    totalRefunded: 0,
    status: BookingStatus.CONFIRMED,
    paymentStatus: PaymentStatus.PAID,
    ...overrides,
  };
}

describe("RefundPolicyService", () => {
  let eventOwnershipService: { assertCanManageEvent: jest.Mock };
  let policy: RefundPolicyService;

  beforeEach(() => {
    eventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
    };
    policy = new RefundPolicyService(eventOwnershipService as never);
  });

  describe("assertRequestOwner", () => {
    it("allows the booking owner", () => {
      const booking = makeBooking({
        userId: new Types.ObjectId("507f1f77bcf86cd799439011"),
      });
      expect(() =>
        policy.assertRequestOwner(
          { userId: "507f1f77bcf86cd799439011", role: "user", iat: 0, exp: 0 },
          booking
        )
      ).not.toThrow();
    });

    it("forbids a non-owner from requesting a refund", () => {
      const booking = makeBooking();
      expect(() => policy.assertRequestOwner(stranger, booking)).toThrow(
        ForbiddenException
      );
    });
  });

  describe("assertViewOwner", () => {
    it("forbids viewing another user's refund request", () => {
      const request = {
        userId: new Types.ObjectId("507f1f77bcf86cd799439011"),
      } as never;
      expect(() => policy.assertViewOwner(stranger, request)).toThrow(
        ForbiddenException
      );
    });
  });

  describe("assertBookingRefundable", () => {
    it("allows a confirmed, paid booking", () => {
      expect(() => policy.assertBookingRefundable(makeBooking())).not.toThrow();
    });

    it("rejects a pending booking", () => {
      expect(() =>
        policy.assertBookingRefundable(
          makeBooking({ status: BookingStatus.PENDING })
        )
      ).toThrow(BadRequestException);
    });

    it("rejects an unpaid booking", () => {
      expect(() =>
        policy.assertBookingRefundable(
          makeBooking({ paymentStatus: PaymentStatus.UNPAID })
        )
      ).toThrow(BadRequestException);
    });

    it("rejects an already-cancelled booking", () => {
      expect(() =>
        policy.assertBookingRefundable(
          makeBooking({ status: BookingStatus.CANCELLED })
        )
      ).toThrow(BadRequestException);
    });
  });

  describe("assertBookingRefundableForReview", () => {
    it("allows confirmed + paid", () => {
      expect(() =>
        policy.assertBookingRefundableForReview(makeBooking())
      ).not.toThrow();
    });

    it("allows confirmed + refund_pending (retry path after a prior failed provider call)", () => {
      expect(() =>
        policy.assertBookingRefundableForReview(
          makeBooking({ paymentStatus: PaymentStatus.REFUND_PENDING })
        )
      ).not.toThrow();
    });

    it("rejects a booking no longer confirmed", () => {
      expect(() =>
        policy.assertBookingRefundableForReview(
          makeBooking({ status: BookingStatus.CANCELLED })
        )
      ).toThrow(ConflictException);
    });

    it("rejects a booking already fully refunded", () => {
      expect(() =>
        policy.assertBookingRefundableForReview(
          makeBooking({ paymentStatus: PaymentStatus.REFUNDED })
        )
      ).toThrow(ConflictException);
    });
  });

  describe("resolveRefundAmount", () => {
    it("defaults to the full refundable amount when none is requested", () => {
      const booking = makeBooking({ totalPrice: 100000, totalRefunded: 0 });
      expect(policy.resolveRefundAmount(booking, undefined)).toBe(100000);
    });

    it("accounts for a prior partial refund", () => {
      const booking = makeBooking({ totalPrice: 100000, totalRefunded: 40000 });
      expect(policy.resolveRefundAmount(booking, undefined)).toBe(60000);
    });

    it("accepts a valid partial amount within the refundable range for a Stripe-paid booking", () => {
      const booking = makeBooking({
        totalPrice: 100000,
        totalRefunded: 0,
        stripePaymentIntentId: "pi_123",
      });
      expect(policy.resolveRefundAmount(booking, 30000)).toBe(30000);
    });

    it("rejects a partial amount for a booking with no stripePaymentIntentId (PayPal — no exchange-rate-safe partial support)", () => {
      const booking = makeBooking({
        totalPrice: 100000,
        totalRefunded: 0,
        stripePaymentIntentId: undefined,
      });
      expect(() => policy.resolveRefundAmount(booking, 30000)).toThrow(
        BadRequestException
      );
    });

    it("allows a full-amount request (not partial) for a PayPal booking", () => {
      const booking = makeBooking({
        totalPrice: 100000,
        totalRefunded: 0,
        stripePaymentIntentId: undefined,
      });
      expect(policy.resolveRefundAmount(booking, 100000)).toBe(100000);
    });

    it("allows an undefined amount (defaults to full) for a PayPal booking", () => {
      const booking = makeBooking({
        totalPrice: 100000,
        totalRefunded: 0,
        stripePaymentIntentId: undefined,
      });
      expect(policy.resolveRefundAmount(booking, undefined)).toBe(100000);
    });

    it("rejects an amount exceeding the refundable balance", () => {
      const booking = makeBooking({ totalPrice: 100000, totalRefunded: 40000 });
      expect(() => policy.resolveRefundAmount(booking, 70000)).toThrow(
        BadRequestException
      );
    });

    it("rejects a zero amount", () => {
      const booking = makeBooking({ totalPrice: 100000, totalRefunded: 0 });
      expect(() => policy.resolveRefundAmount(booking, 0)).toThrow(
        BadRequestException
      );
    });

    it("rejects a negative amount", () => {
      const booking = makeBooking({ totalPrice: 100000, totalRefunded: 0 });
      expect(() => policy.resolveRefundAmount(booking, -1)).toThrow(
        BadRequestException
      );
    });

    it("rejects when the booking is already fully refunded (refundable balance is zero)", () => {
      const booking = makeBooking({
        totalPrice: 100000,
        totalRefunded: 100000,
      });
      expect(() => policy.resolveRefundAmount(booking, undefined)).toThrow(
        BadRequestException
      );
    });
  });

  describe("assertCanReview", () => {
    it("forbids a plain user from reviewing", async () => {
      await expect(
        policy.assertCanReview(owner, new Types.ObjectId().toHexString())
      ).rejects.toThrow(ForbiddenException);
      expect(eventOwnershipService.assertCanManageEvent).not.toHaveBeenCalled();
    });

    it("allows admin and re-checks event ownership (admin bypasses inside that call)", async () => {
      const eventId = new Types.ObjectId().toHexString();
      await policy.assertCanReview(admin, eventId);
      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        admin,
        eventId
      );
    });

    it("allows organizer only if they own the event", async () => {
      const eventId = new Types.ObjectId().toHexString();
      await policy.assertCanReview(organizer, eventId);
      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        organizer,
        eventId
      );
    });

    it("propagates ForbiddenException from ownership check for an organizer who doesn't own the event", async () => {
      eventOwnershipService.assertCanManageEvent.mockRejectedValue(
        new ForbiddenException()
      );
      await expect(
        policy.assertCanReview(organizer, new Types.ObjectId().toHexString())
      ).rejects.toThrow(ForbiddenException);
    });
  });
});
