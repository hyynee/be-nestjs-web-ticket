/**
 * Booking Zone Capacity — real MongoDB transactions (NEW#10)
 *
 * production-readiness-audit-2026-07-22.md NEW#10: no test validated the
 * core overselling guard — the atomic `Zone.findOneAndUpdate` `$expr`
 * capacity check in create-booking.use-case.ts — under real concurrent
 * transactions against a real replica set. `booking.concurrency.spec.ts`
 * covers a DIFFERENT invariant (the Redis per-timeslot counter) with
 * `zoneModel.findOneAndUpdate` entirely mocked to always succeed, so it
 * cannot prove the Mongo-level guard actually prevents overselling.
 *
 * This suite fires many concurrent `createBooking` calls — one per distinct
 * user, so the per-(user,event) Redis lock in createBooking never
 * serializes them — against a zone with limited capacity on a real
 * `MongoMemoryReplSet` (transactions require a replica set, not a single
 * mongod). Zone.findOneAndUpdate is never mocked.
 *
 * Gated by RUN_BOOKING_CONCURRENCY_INTEGRATION=true (see ci.yml), same
 * convention as RUN_AREA_INTEGRATION / RUN_PAYMENT_INTEGRATION, so the
 * default `pnpm test` dev loop stays fast.
 */
import { BadRequestException } from "@nestjs/common";
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Connection, Types } from "mongoose";

import { Area, AreaSchema } from "@src/schemas/area.schema";
import {
  Booking,
  BookingSchema,
  SeatLock,
  SeatLockSchema,
} from "@src/schemas/booking.schema";
import { Event, EventSchema, EventStatus } from "@src/schemas/event.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { SeatState, SeatStateSchema } from "@src/schemas/seat-state.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";

import { EventOwnershipService } from "@src/event/event-ownership.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { NotificationService } from "@src/notification/notification.service";
import { PaymentService } from "@src/payment/payment.service";
import { PromotionService } from "@src/promotion/promotion.service";
import { RedisService } from "@src/redis/redis.service";
import { AuditService } from "@src/audit/audit.service";
import { UploadService } from "@src/upload/upload.service";
import { ZoneService } from "@src/zone/zone.service";
import { ZoneGateway } from "@src/zone/zone.gateway";

import { CreateBookingUseCase } from "../application/use-case/create-booking.use-case";
import { BookingCodeService } from "../domain/services/booking-code.service";
import { BookingCacheService } from "../infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "../infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "../presenters/booking.presenter";

const shouldRun = process.env.RUN_BOOKING_CONCURRENCY_INTEGRATION === "true";
const describeIntegration = shouldRun ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

let replSet: MongoMemoryReplSet;
let moduleRef: TestingModule;
let connection: Connection;
let createBookingUseCase: CreateBookingUseCase;
let eventModel: any;
let zoneModel: any;
let bookingModel: any;

const mockRedisClient = {
  set: jest.fn().mockResolvedValue("OK"),
  get: jest.fn().mockResolvedValue(null),
  del: jest.fn().mockResolvedValue(0),
  eval: jest.fn().mockResolvedValue(null),
  incrBy: jest.fn(),
  decrBy: jest.fn().mockResolvedValue(0),
  expire: jest.fn().mockResolvedValue(1),
};

const mockMetricsService = {
  bookingsTotal: { inc: jest.fn() },
  bookingConflictTotal: { inc: jest.fn() },
  redisOperationFailureTotal: { inc: jest.fn() },
};

const mockBookingCacheService = {
  invalidateBookingCache: jest.fn().mockResolvedValue(undefined),
  invalidateUserBookingCache: jest.fn().mockResolvedValue(undefined),
};

const mockNotificationService = {
  notifyBookingCreated: jest.fn().mockResolvedValue(undefined),
};

beforeAll(async () => {
  if (!shouldRun) {
    return;
  }

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();

  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri, {
        dbName: "booking_capacity_integration_test",
      }),
      MongooseModule.forFeature([
        { name: Booking.name, schema: BookingSchema },
        { name: SeatLock.name, schema: SeatLockSchema },
        { name: Event.name, schema: EventSchema },
        { name: Zone.name, schema: ZoneSchema },
        { name: Area.name, schema: AreaSchema },
        { name: Ticket.name, schema: TicketSchema },
        { name: Payment.name, schema: PaymentSchema },
        { name: SeatState.name, schema: SeatStateSchema },
      ]),
    ],
    providers: [
      CreateBookingUseCase,
      BookingPresenter,
      BookingCodeService,
      { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
      {
        provide: ZoneService,
        useValue: { invalidateZoneAvailabilityCache: jest.fn() },
      },
      { provide: RedisService, useValue: { client: mockRedisClient } },
      { provide: PaymentService, useValue: { issueAdminRefund: jest.fn() } },
      { provide: MetricsService, useValue: mockMetricsService },
      { provide: AuditService, useValue: { record: jest.fn() } },
      { provide: UploadService, useValue: { deleteQRCode: jest.fn() } },
      {
        provide: EventOwnershipService,
        useValue: {
          assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: BookingCacheService, useValue: mockBookingCacheService },
      {
        provide: BookingZoneNotifierService,
        useValue: {
          emitZoneTicketUpdate: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: NotificationService, useValue: mockNotificationService },
      {
        provide: PromotionService,
        useValue: { applyPromotionToBooking: jest.fn() },
      },
    ],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  createBookingUseCase = moduleRef.get(CreateBookingUseCase);
  eventModel = connection.model(Event.name);
  zoneModel = connection.model(Zone.name);
  bookingModel = connection.model(Booking.name);
}, 120_000);

afterAll(async () => {
  if (!shouldRun) {
    return;
  }
  await moduleRef?.close();
  await replSet?.stop();
});

beforeEach(async () => {
  if (!shouldRun) {
    return;
  }
  await Promise.all([
    eventModel.deleteMany({}),
    zoneModel.deleteMany({}),
    bookingModel.deleteMany({}),
  ]);
  jest.clearAllMocks();
  mockRedisClient.set.mockResolvedValue("OK");
  mockRedisClient.eval.mockResolvedValue(null);
});

const seedEvent = () =>
  eventModel.create({
    title: "Concurrency Test Event",
    startDate: new Date(Date.now() + DAY_MS),
    endDate: new Date(Date.now() + 2 * DAY_MS),
    location: "Test Venue",
    status: EventStatus.ACTIVE,
    createdBy: new Types.ObjectId(),
    timeSlots: [],
  });

const seedZone = (eventId: Types.ObjectId, capacity: number) =>
  zoneModel.create({
    eventId,
    name: "General Admission",
    price: 100_000,
    capacity,
    soldCount: 0,
    hasSeating: false,
    isDeleted: false,
  });

describeIntegration(
  "CreateBookingUseCase — zone capacity overselling guard (real Mongo transactions)",
  () => {
    it("50 concurrent createBooking calls (distinct users) against capacity=10: exactly 10 succeed, soldCount ends at exactly 10, no overselling", async () => {
      const CAPACITY = 10;
      const CONCURRENT_REQUESTS = 50;

      const event = await seedEvent();
      const zone = await seedZone(event._id, CAPACITY);

      const users = Array.from({ length: CONCURRENT_REQUESTS }, () =>
        new Types.ObjectId().toString()
      );
      const dto = {
        eventId: event._id.toString(),
        zoneId: zone._id.toString(),
        quantity: 1,
        customerEmail: "concurrency@test.local",
      };

      const results = await Promise.allSettled(
        users.map((userId) =>
          createBookingUseCase.createBooking(userId, dto as any)
        )
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      const capacityRejections = rejected.filter(
        (r) =>
          r.reason instanceof BadRequestException &&
          r.reason.message.includes("Không đủ vé")
      );

      // Exactly CAPACITY bookings succeeded — the real atomic $expr guard
      // in Zone.findOneAndUpdate, not the mocked version, enforced this
      // under genuine concurrent transactions.
      expect(succeeded).toHaveLength(CAPACITY);
      expect(rejected).toHaveLength(CONCURRENT_REQUESTS - CAPACITY);
      expect(capacityRejections).toHaveLength(CONCURRENT_REQUESTS - CAPACITY);

      // Re-read the zone from real Mongo — soldCount must land exactly at
      // capacity, never above it (the actual overselling invariant).
      const zoneAfter = await zoneModel.findById(zone._id).lean();
      expect(zoneAfter!.soldCount).toBe(CAPACITY);
      expect(zoneAfter!.soldCount).toBeLessThanOrEqual(zoneAfter!.capacity);

      // The count of Booking documents actually persisted must match the
      // number of successful results exactly — no phantom/duplicate writes.
      const bookingCount = await bookingModel.countDocuments({
        eventId: event._id,
        zoneId: zone._id,
      });
      expect(bookingCount).toBe(CAPACITY);
    }, 60_000);

    it("concurrent requests each booking quantity=3 against capacity=10: no combination is allowed to push soldCount past capacity", async () => {
      const CAPACITY = 10;
      const QUANTITY_PER_REQUEST = 3;
      const CONCURRENT_REQUESTS = 10; // 10 * 3 = 30 requested, only 3 batches of 3 (=9) can fit

      const event = await seedEvent();
      const zone = await seedZone(event._id, CAPACITY);

      const users = Array.from({ length: CONCURRENT_REQUESTS }, () =>
        new Types.ObjectId().toString()
      );
      const dto = {
        eventId: event._id.toString(),
        zoneId: zone._id.toString(),
        quantity: QUANTITY_PER_REQUEST,
        customerEmail: "concurrency-multi@test.local",
      };

      const results = await Promise.allSettled(
        users.map((userId) =>
          createBookingUseCase.createBooking(userId, dto as any)
        )
      );

      const succeeded = results.filter((r) => r.status === "fulfilled");

      // At most floor(CAPACITY / QUANTITY_PER_REQUEST) = 3 requests can be
      // admitted without exceeding capacity (10 - 3*3 = 1 remaining, too
      // small for a 4th request of 3).
      expect(succeeded.length).toBeLessThanOrEqual(
        Math.floor(CAPACITY / QUANTITY_PER_REQUEST)
      );

      const zoneAfter = await zoneModel.findById(zone._id).lean();
      expect(zoneAfter!.soldCount).toBe(
        succeeded.length * QUANTITY_PER_REQUEST
      );
      expect(zoneAfter!.soldCount).toBeLessThanOrEqual(CAPACITY);
    }, 60_000);
  }
);
