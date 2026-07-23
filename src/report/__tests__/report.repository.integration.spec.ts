/**
 * ReportRepository integration tests — real MongoDB aggregation pipelines.
 *
 * Runs on a single-node `MongoMemoryServer` (no transactions involved, only
 * read aggregations, so a replica set is not required). Verifies the
 * arithmetic identity gross - refund = net, date-range filtering, and that
 * the reconciliation detectors actually catch seeded anomalies — mocking
 * `.aggregate()` would only prove the repository calls Mongoose, not that
 * the pipelines are correct.
 */
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import { Connection, Types } from "mongoose";

import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import {
  PaymentWebhookEvent,
  PaymentWebhookEventSchema,
  PaymentWebhookEventStatus,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";
import {
  RefundProvider,
  RefundRequest,
  RefundRequestSchema,
  RefundRequestStatus,
} from "@src/schemas/refund-request.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";

import { ReportEventScope } from "../domain/policies/report-scope.policy";
import { resolveReportDateRange } from "../domain/report-range.util";
import { ReportRepository } from "../infrastructure/persistence/report.repository";

jest.setTimeout(60000);

let mongod: MongoMemoryServer;
let moduleRef: TestingModule;
let connection: Connection;
let repository: ReportRepository;

let bookingModel: any;
let ticketModel: any;
let paymentModel: any;
let refundRequestModel: any;
let webhookEventModel: any;

const eventA = new Types.ObjectId();
const eventB = new Types.ObjectId();
const zoneA1 = new Types.ObjectId();
const staffUser = new Types.ObjectId();

const scopeEventA: ReportEventScope = { eventIdEq: eventA };
const scopeUnrestricted: ReportEventScope = {};

const RANGE_FROM = "2026-03-01";
const RANGE_TO = "2026-03-31";
const IN_RANGE = new Date("2026-03-10T08:00:00.000Z");
const OUT_OF_RANGE = new Date("2026-01-01T08:00:00.000Z");

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();

  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri, { dbName: "report_repository_test" }),
      MongooseModule.forFeature([
        { name: Booking.name, schema: BookingSchema },
        { name: Ticket.name, schema: TicketSchema },
        { name: Payment.name, schema: PaymentSchema },
        { name: RefundRequest.name, schema: RefundRequestSchema },
        { name: PaymentWebhookEvent.name, schema: PaymentWebhookEventSchema },
      ]),
    ],
    providers: [ReportRepository],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  repository = moduleRef.get(ReportRepository);
  bookingModel = connection.model(Booking.name);
  ticketModel = connection.model(Ticket.name);
  paymentModel = connection.model(Payment.name);
  refundRequestModel = connection.model(RefundRequest.name);
  webhookEventModel = connection.model(PaymentWebhookEvent.name);
}, 60000);

afterAll(async () => {
  await moduleRef?.close();
  await mongod?.stop();
});

afterEach(async () => {
  await Promise.all([
    bookingModel.deleteMany({}),
    ticketModel.deleteMany({}),
    paymentModel.deleteMany({}),
    refundRequestModel.deleteMany({}),
    webhookEventModel.deleteMany({}),
  ]);
});

function baseBooking(overrides: Record<string, unknown> = {}) {
  return {
    bookingCode: `BK${new Types.ObjectId().toHexString()}`,
    userId: new Types.ObjectId(),
    eventId: eventA,
    zoneId: zoneA1,
    quantity: 1,
    pricePerTicket: 10000,
    totalPrice: 10000,
    originalTotalPrice: 10000,
    discountAmount: 0,
    status: "confirmed",
    paymentStatus: "paid",
    expiresAt: new Date(Date.now() + 60_000),
    customerEmail: "buyer@example.com",
    totalRefunded: 0,
    isDeleted: false,
    ...overrides,
  };
}

describe("ReportRepository — sales report", () => {
  it("computes gross/net/refund/tickets/bookingCount within the date range only", async () => {
    await bookingModel.create([
      baseBooking({
        totalPrice: 100000,
        totalRefunded: 0,
        quantity: 2,
        paidAt: IN_RANGE,
      }),
      baseBooking({
        totalPrice: 50000,
        totalRefunded: 50000,
        quantity: 1,
        status: "cancelled",
        paymentStatus: "refunded",
        paidAt: new Date("2026-03-15T08:00:00.000Z"),
      }),
      baseBooking({
        totalPrice: 999999,
        quantity: 9,
        paidAt: OUT_OF_RANGE,
      }),
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const summary = await repository.querySalesSummary(scopeEventA, range);

    expect(summary.grossRevenue).toBe(150000);
    expect(summary.refundAmount).toBe(50000);
    expect(summary.netRevenue).toBe(100000);
    expect(summary.ticketsSold).toBe(3);
    expect(summary.bookingCount).toBe(2);
    expect(summary.averageOrderValue).toBe(50000);
  });

  it("excludes bookings from a different event when scoped by eventIdEq", async () => {
    await bookingModel.create([
      baseBooking({ eventId: eventA, totalPrice: 10000, paidAt: IN_RANGE }),
      baseBooking({ eventId: eventB, totalPrice: 999999, paidAt: IN_RANGE }),
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const summary = await repository.querySalesSummary(scopeEventA, range);

    expect(summary.grossRevenue).toBe(10000);
  });

  it("returns zero-match summary for organizer scope with an empty eventIdIn", async () => {
    await bookingModel.create([
      baseBooking({ eventId: eventA, totalPrice: 10000, paidAt: IN_RANGE }),
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const summary = await repository.querySalesSummary(
      { eventIdIn: [] },
      range
    );

    expect(summary.grossRevenue).toBe(0);
    expect(summary.bookingCount).toBe(0);
  });

  it("breaks revenue down by event with pagination metadata", async () => {
    await bookingModel.create([
      baseBooking({ eventId: eventA, totalPrice: 10000, paidAt: IN_RANGE }),
      baseBooking({ eventId: eventB, totalPrice: 20000, paidAt: IN_RANGE }),
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const result = await repository.querySalesByEvent(
      scopeUnrestricted,
      range,
      1,
      10
    );

    expect(result.meta.totalItems).toBe(2);
    expect(
      result.items.map((i) => i.grossRevenue).sort((a, b) => a - b)
    ).toEqual([10000, 20000]);
  });
});

describe("ReportRepository — check-in report", () => {
  it("computes totalValidTickets/checkedInTickets/noShowCount/checkInRate", async () => {
    await ticketModel.create([
      {
        ticketCode: "TK1",
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: zoneA1,
        price: 10000,
        status: "used",
        checkedInAt: IN_RANGE,
        checkedInBy: staffUser,
        createdAt: IN_RANGE,
        isDeleted: false,
      },
      {
        ticketCode: "TK2",
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: zoneA1,
        price: 10000,
        status: "valid",
        createdAt: IN_RANGE,
        isDeleted: false,
      },
      {
        ticketCode: "TK3",
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: zoneA1,
        price: 10000,
        status: "cancelled",
        createdAt: IN_RANGE,
        isDeleted: false,
      },
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const summary = await repository.queryCheckInSummary(scopeEventA, range);

    expect(summary.totalValidTickets).toBe(2);
    expect(summary.checkedInTickets).toBe(1);
    expect(summary.noShowCount).toBe(1);
    expect(summary.checkInRate).toBe(50);
  });
});

describe("ReportRepository — refund report", () => {
  it("counts requested/approved/rejected/succeeded/failed and sums succeeded amount", async () => {
    await refundRequestModel.create([
      {
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 20000,
        reason: "r1",
        status: RefundRequestStatus.SUCCEEDED,
        provider: RefundProvider.STRIPE,
        createdAt: IN_RANGE,
      },
      {
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 5000,
        reason: "r2",
        status: RefundRequestStatus.REQUESTED,
        createdAt: IN_RANGE,
      },
      {
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 5000,
        reason: "r3",
        status: RefundRequestStatus.REJECTED,
        createdAt: IN_RANGE,
      },
      {
        bookingId: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 5000,
        reason: "r4",
        status: RefundRequestStatus.FAILED,
        createdAt: IN_RANGE,
      },
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const summary = await repository.queryRefundSummary(scopeEventA, range);

    expect(summary.requested).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.approved).toBe(2); // succeeded + failed both passed approval
    expect(summary.totalRefundAmount).toBe(20000);
  });
});

describe("ReportRepository — payment reconciliation", () => {
  it("detects a booking that is paid but has no issued ticket", async () => {
    const [paidNoTicket] = await bookingModel.create([
      baseBooking({ paidAt: IN_RANGE, totalPrice: 30000 }),
    ]);
    // A separately paid booking WITH a ticket must not be flagged.
    const [paidWithTicket] = await bookingModel.create([
      baseBooking({ paidAt: IN_RANGE, totalPrice: 15000 }),
    ]);
    await ticketModel.create([
      {
        ticketCode: "TK-OK",
        bookingId: paidWithTicket._id,
        userId: new Types.ObjectId(),
        eventId: eventA,
        zoneId: zoneA1,
        price: 15000,
        status: "valid",
        isDeleted: false,
      },
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const rows = await repository.queryBookingPaidWithoutTicket(
      scopeEventA,
      range
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].bookingId).toBe(paidNoTicket._id.toString());
  });

  it("detects a succeeded payment whose booking is not confirmed", async () => {
    const [pendingBooking] = await bookingModel.create([
      baseBooking({ status: "pending", paymentStatus: "unpaid" }),
    ]);
    await paymentModel.create([
      {
        bookingId: pendingBooking._id,
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 10000,
        status: "succeeded",
        isDeleted: false,
        createdAt: IN_RANGE,
      },
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const rows = await repository.queryPaymentSucceededBookingNotConfirmed(
      scopeEventA,
      range
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].bookingId).toBe(pendingBooking._id.toString());
  });

  it("detects duplicate succeeded payment records for the same booking", async () => {
    const [booking] = await bookingModel.create([baseBooking({})]);
    await paymentModel.create([
      {
        bookingId: booking._id,
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 10000,
        status: "succeeded",
        isDeleted: false,
        createdAt: IN_RANGE,
      },
      {
        bookingId: booking._id,
        userId: new Types.ObjectId(),
        eventId: eventA,
        amount: 10000,
        status: "succeeded",
        isDeleted: false,
        createdAt: IN_RANGE,
      },
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const rows = await repository.queryDuplicatePaymentRecords(
      scopeEventA,
      range
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(2);
  });

  it("only surfaces payment_webhook_failed via the unrestricted admin path", async () => {
    await webhookEventModel.create([
      {
        provider: PaymentWebhookProvider.STRIPE,
        eventId: "evt_1",
        eventType: "checkout.session.completed",
        status: PaymentWebhookEventStatus.FAILED,
        payload: {},
        createdAt: IN_RANGE,
      },
    ]);

    const range = resolveReportDateRange(RANGE_FROM, RANGE_TO);
    const rows = await repository.queryPaymentWebhookFailed(range);

    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe(PaymentWebhookProvider.STRIPE);
  });
});
