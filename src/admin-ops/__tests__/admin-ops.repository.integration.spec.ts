/**
 * AdminOpsRepository integration tests — real MongoDB via MongoMemoryServer
 * (single-node; these are plain reads, no transactions needed). Mocking
 * `.find()`/`.countDocuments()` would only prove the repository calls
 * Mongoose, not that the anomaly filters (missing-QR, grace-period
 * boundary, notification correlation) are actually correct.
 */
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Connection, Types } from "mongoose";

import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import {
  Notification,
  NotificationChannel,
  NotificationSchema,
  NotificationStatus,
  NotificationType,
} from "@src/schemas/notification.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";

import { BOOKING_PENDING_GRACE_MINUTES } from "../admin-ops.constants";
import { AdminOpsRepository } from "../infrastructure/persistence/admin-ops.repository";

jest.setTimeout(60000);

let mongod: MongoMemoryServer;
let moduleRef: TestingModule;
let connection: Connection;
let repository: AdminOpsRepository;

let bookingModel: any;
let ticketModel: any;
let notificationModel: any;

const eventA = new Types.ObjectId();

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri, { dbName: "admin_ops_repository_test" }),
      MongooseModule.forFeature([
        { name: Booking.name, schema: BookingSchema },
        { name: Ticket.name, schema: TicketSchema },
        { name: Notification.name, schema: NotificationSchema },
      ]),
    ],
    providers: [AdminOpsRepository],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  repository = moduleRef.get(AdminOpsRepository);
  bookingModel = connection.model(Booking.name);
  ticketModel = connection.model(Ticket.name);
  notificationModel = connection.model(Notification.name);
}, 60000);

afterAll(async () => {
  await moduleRef?.close();
  await mongod?.stop();
});

afterEach(async () => {
  await Promise.all([
    bookingModel.deleteMany({}),
    ticketModel.deleteMany({}),
    notificationModel.deleteMany({}),
  ]);
});

function baseBooking(overrides: Record<string, unknown> = {}) {
  return {
    bookingCode: `BK${new Types.ObjectId().toHexString()}`,
    userId: new Types.ObjectId(),
    eventId: eventA,
    zoneId: new Types.ObjectId(),
    quantity: 1,
    pricePerTicket: 10000,
    totalPrice: 10000,
    originalTotalPrice: 10000,
    discountAmount: 0,
    status: "pending",
    paymentStatus: "unpaid",
    expiresAt: new Date(Date.now() + 60_000),
    customerEmail: "buyer@example.com",
    totalRefunded: 0,
    isDeleted: false,
    ...overrides,
  };
}

describe("AdminOpsRepository — ticket missing QR", () => {
  it("detects a valid ticket with no qrCode field, and ignores one with a qrCode", async () => {
    await ticketModel.create([
      {
        ticketCode: "TK-NO-QR",
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: new Types.ObjectId(),
        price: 10000,
        status: "valid",
        isDeleted: false,
      },
      {
        ticketCode: "TK-HAS-QR",
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: new Types.ObjectId(),
        price: 10000,
        status: "valid",
        qrCode: "https://cdn/qrcodes/TK-HAS-QR.png",
        isDeleted: false,
      },
    ]);

    const rows = await repository.queryTicketsMissingQr();

    expect(rows).toHaveLength(1);
    expect(rows[0].ticketCode).toBe("TK-NO-QR");
  });

  it("ignores cancelled/expired tickets even without a qrCode", async () => {
    await ticketModel.create([
      {
        ticketCode: "TK-CANCELLED",
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: new Types.ObjectId(),
        price: 10000,
        status: "cancelled",
        isDeleted: false,
      },
    ]);

    const rows = await repository.queryTicketsMissingQr();

    expect(rows).toHaveLength(0);
  });
});

describe("AdminOpsRepository — payment succeeded but email failed", () => {
  it("detects a failed PAYMENT_SUCCEEDED email notification and surfaces its bookingCode", async () => {
    await notificationModel.create([
      {
        userId: new Types.ObjectId(),
        type: NotificationType.PAYMENT_SUCCEEDED,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.FAILED,
        title: "x",
        body: "x",
        errorMessage: "SMTP timeout",
        metadata: { bookingCode: "BK-EMAIL-FAILED" },
      },
      // sent (not failed) — must not be picked up
      {
        userId: new Types.ObjectId(),
        type: NotificationType.PAYMENT_SUCCEEDED,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.SENT,
        title: "x",
        body: "x",
        metadata: { bookingCode: "BK-EMAIL-OK" },
      },
      // failed in-app (wrong channel) — must not be picked up
      {
        userId: new Types.ObjectId(),
        type: NotificationType.PAYMENT_SUCCEEDED,
        channel: NotificationChannel.IN_APP,
        status: NotificationStatus.FAILED,
        title: "x",
        body: "x",
        metadata: { bookingCode: "BK-INAPP-FAILED" },
      },
    ]);

    const rows = await repository.queryPaymentSucceededEmailFailed();

    expect(rows).toHaveLength(1);
    expect(rows[0].bookingCode).toBe("BK-EMAIL-FAILED");
    expect(rows[0].errorMessage).toBe("SMTP timeout");
  });
});

describe("AdminOpsRepository — booking pending past expiry", () => {
  it("detects a pending booking whose expiry is well past the grace period", async () => {
    const wellPastExpiry = new Date(
      Date.now() - (BOOKING_PENDING_GRACE_MINUTES + 5) * 60 * 1000
    );
    await bookingModel.create([
      baseBooking({ bookingCode: "BK-STUCK", expiresAt: wellPastExpiry }),
    ]);

    const rows = await repository.queryBookingsPendingPastExpiry();

    expect(rows).toHaveLength(1);
    expect(rows[0].bookingCode).toBe("BK-STUCK");
  });

  it("does not flag a pending booking that expired inside the grace window", async () => {
    const justExpired = new Date(
      Date.now() - (BOOKING_PENDING_GRACE_MINUTES - 2) * 60 * 1000
    );
    await bookingModel.create([
      baseBooking({ bookingCode: "BK-RECENT", expiresAt: justExpired }),
    ]);

    const rows = await repository.queryBookingsPendingPastExpiry();

    expect(rows).toHaveLength(0);
  });

  it("does not flag a confirmed booking even if its expiresAt is in the past", async () => {
    const wellPastExpiry = new Date(
      Date.now() - (BOOKING_PENDING_GRACE_MINUTES + 5) * 60 * 1000
    );
    await bookingModel.create([
      baseBooking({
        bookingCode: "BK-CONFIRMED",
        status: "confirmed",
        paymentStatus: "paid",
        expiresAt: wellPastExpiry,
      }),
    ]);

    const rows = await repository.queryBookingsPendingPastExpiry();

    expect(rows).toHaveLength(0);
  });
});

describe("AdminOpsRepository — loadBookingForResend", () => {
  it("returns the booking by normalized bookingCode", async () => {
    await bookingModel.create([
      baseBooking({ bookingCode: "BK-RESEND", status: "confirmed" }),
    ]);

    const booking = await repository.loadBookingForResend("BK-RESEND");

    expect(booking).not.toBeNull();
    expect(booking?.bookingCode).toBe("BK-RESEND");
  });

  it("returns null when the booking does not exist", async () => {
    const booking = await repository.loadBookingForResend("BK-MISSING");
    expect(booking).toBeNull();
  });
});
