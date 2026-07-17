import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Types } from "mongoose";

import { InvoiceService } from "./invoice.service";
import { InvoicePdfService } from "./infrastructure/pdf/invoice-pdf.service";
import { Booking, PaymentStatus } from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { MailService } from "@src/services/mail.service";
import { QueueService } from "@src/queue/queue.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";

function leanQuery<T>(result: T) {
  return { lean: jest.fn().mockResolvedValue(result) };
}

function sortableLeanQuery<T>(result: T) {
  return {
    sort: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(result),
    }),
  };
}

function selectLeanQuery<T>(result: T) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(result),
    }),
  };
}

describe("InvoiceService", () => {
  let service: InvoiceService;
  let bookingModel: { findOne: jest.Mock };
  let paymentModel: { findOne: jest.Mock };
  let eventModel: { findById: jest.Mock };
  let zoneModel: { findById: jest.Mock };
  let areaModel: { findById: jest.Mock };
  let queueService: { addJob: jest.Mock };
  let mailService: { deliverInvoiceEmail: jest.Mock };

  const ownerId = new Types.ObjectId().toString();
  const otherUserId = new Types.ObjectId().toString();
  const bookingObjectId = new Types.ObjectId();

  const ownerUser: JwtPayload = {
    userId: ownerId,
    role: "user",
    iat: 0,
    exp: 0,
  };
  const otherUser: JwtPayload = {
    userId: otherUserId,
    role: "user",
    iat: 0,
    exp: 0,
  };
  const adminUser: JwtPayload = {
    userId: new Types.ObjectId().toString(),
    role: "admin",
    iat: 0,
    exp: 0,
  };

  function makePaidBooking(overrides: Record<string, unknown> = {}) {
    return {
      _id: bookingObjectId,
      bookingCode: "BK123",
      userId: new Types.ObjectId(ownerId),
      eventId: new Types.ObjectId(),
      zoneId: new Types.ObjectId(),
      areaId: undefined,
      seats: ["A1"],
      quantity: 1,
      pricePerTicket: 100000,
      totalPrice: 100000,
      snapshot: {
        eventTitle: "Concert",
        eventStartDate: new Date("2026-01-01"),
        eventEndDate: new Date("2026-01-02"),
        location: "HCMC",
        zoneName: "VIP",
        areaName: undefined,
        seats: ["A1"],
        pricePerTicket: 100000,
        currency: "vnd",
      },
      paymentStatus: PaymentStatus.PAID,
      customerEmail: "customer@example.com",
      customerName: "John Doe",
      paidAt: new Date("2026-01-01"),
      totalRefunded: 0,
      ...overrides,
    };
  }

  beforeEach(async () => {
    bookingModel = { findOne: jest.fn() };
    paymentModel = { findOne: jest.fn() };
    eventModel = { findById: jest.fn() };
    zoneModel = { findById: jest.fn() };
    areaModel = { findById: jest.fn() };
    queueService = { addJob: jest.fn().mockResolvedValue(undefined) };
    mailService = {
      deliverInvoiceEmail: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InvoiceService,
        InvoicePdfService,
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(Event.name), useValue: eventModel },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Area.name), useValue: areaModel },
        { provide: MailService, useValue: mailService },
        { provide: QueueService, useValue: queueService },
      ],
    }).compile();

    service = module.get(InvoiceService);
  });

  describe("access control", () => {
    it("throws Forbidden when a user requests another user's invoice", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));

      await expect(
        service.getInvoicePdf("BK123", otherUser, { accessMode: "owner" })
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it("allows the owning user to download their own invoice", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));
      paymentModel.findOne.mockReturnValue(
        sortableLeanQuery({
          paymentMethod: "card",
          stripePaymentIntentId: "pi_123",
          currency: "vnd",
        })
      );

      const result = await service.getInvoicePdf("BK123", ownerUser, {
        accessMode: "owner",
      });
      expect(result.buffer).toBeInstanceOf(Buffer);
      expect(result.filename).toBe("invoice-BK123.pdf");
    });

    it("allows admin to download any user's invoice via the admin route", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));
      paymentModel.findOne.mockReturnValue(sortableLeanQuery(null));

      const result = await service.getInvoicePdf("BK123", adminUser, {
        accessMode: "admin",
      });
      expect(result.buffer).toBeInstanceOf(Buffer);
    });
  });

  describe("unpaid bookings", () => {
    it("throws BadRequest when the booking has never been paid", async () => {
      bookingModel.findOne.mockReturnValue(
        leanQuery(
          makePaidBooking({
            paymentStatus: PaymentStatus.UNPAID,
            paidAt: undefined,
          })
        )
      );

      await expect(
        service.getInvoicePdf("BK123", ownerUser, { accessMode: "owner" })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("throws BadRequest even for admin when the booking has never been paid", async () => {
      bookingModel.findOne.mockReturnValue(
        leanQuery(
          makePaidBooking({
            paymentStatus: PaymentStatus.UNPAID,
            paidAt: undefined,
          })
        )
      );

      await expect(
        service.getInvoicePdf("BK123", adminUser, { accessMode: "admin" })
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe("invalid or missing bookingCode", () => {
    it("throws BadRequest for a whitespace-only bookingCode", async () => {
      await expect(
        service.getInvoicePdf("   ", ownerUser, { accessMode: "owner" })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(bookingModel.findOne).not.toHaveBeenCalled();
    });

    it("throws NotFound when no booking matches the code", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(null));

      await expect(
        service.getInvoicePdf("UNKNOWN", ownerUser, { accessMode: "owner" })
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("resendInvoice", () => {
    it("enqueues a resend-invoice-email job for an accessible booking", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));

      const result = await service.resendInvoice("bk123", ownerUser, {
        accessMode: "owner",
      });

      expect(queueService.addJob).toHaveBeenCalledWith({
        type: "resend-invoice-email",
        payload: { bookingCode: "BK123" },
      });
      expect(result.status).toBe(200);
    });

    it("rejects resend for a booking the user does not own", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));

      await expect(
        service.resendInvoice("BK123", otherUser, { accessMode: "owner" })
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it("rejects resend for an unpaid booking", async () => {
      bookingModel.findOne.mockReturnValue(
        leanQuery(
          makePaidBooking({
            paymentStatus: PaymentStatus.UNPAID,
            paidAt: undefined,
          })
        )
      );

      await expect(
        service.resendInvoice("BK123", ownerUser, { accessMode: "owner" })
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(queueService.addJob).not.toHaveBeenCalled();
    });

    it("allows admin to resend for another user's booking via the admin bypass", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));

      const result = await service.resendInvoice("BK123", adminUser, {
        accessMode: "admin",
      });

      expect(queueService.addJob).toHaveBeenCalledWith({
        type: "resend-invoice-email",
        payload: { bookingCode: "BK123" },
      });
      expect(result.status).toBe(200);
    });
  });

  describe("deliverInvoiceEmail", () => {
    it("builds the PDF and sends it via MailService without an ownership check", async () => {
      bookingModel.findOne.mockReturnValue(leanQuery(makePaidBooking()));
      paymentModel.findOne.mockReturnValue(sortableLeanQuery(null));

      await service.deliverInvoiceEmail("BK123");

      expect(mailService.deliverInvoiceEmail).toHaveBeenCalledWith(
        expect.objectContaining({
          to: "customer@example.com",
          bookingCode: "BK123",
          pdfBuffer: expect.any(Buffer),
        })
      );
    });
  });

  describe("snapshot fallback", () => {
    it("falls back to live event/zone/area lookups when snapshot is absent", async () => {
      bookingModel.findOne.mockReturnValue(
        leanQuery(makePaidBooking({ snapshot: undefined }))
      );
      paymentModel.findOne.mockReturnValue(sortableLeanQuery(null));
      eventModel.findById.mockReturnValue(
        selectLeanQuery({
          title: "Live Event",
          location: "Live Loc",
          startDate: new Date(),
        })
      );
      zoneModel.findById.mockReturnValue(
        selectLeanQuery({ name: "Live Zone" })
      );
      areaModel.findById.mockReturnValue(selectLeanQuery(null));

      const result = await service.getInvoicePdf("BK123", ownerUser, {
        accessMode: "owner",
      });

      expect(eventModel.findById).toHaveBeenCalled();
      expect(zoneModel.findById).toHaveBeenCalled();
      expect(result.buffer).toBeInstanceOf(Buffer);
    });
  });
});
