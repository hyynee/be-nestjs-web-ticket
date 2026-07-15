/**
 * Integration Tests: Concurrency Stress & DB Transaction Consistency
 *
 * Mục tiêu:
 *   1. Concurrency Stress – 20 request đồng thời cho cùng 1 Time Slot (capacity = 5).
 *      Chỉ đúng 5 booking được phép tạo; 15 còn lại bị từ chối bởi Redis atomic counter.
 *   2. DB Transaction Consistency – Redis đã tăng counter (INCRBY) nhưng MongoDB
 *      ghi thất bại → hệ thống phải gọi DECRBY để rollback counter (atomic consistency).
 *
 * Mock strategy:
 *   - Redis: mock cứng (shared in-memory counter cho INCRBY/DECRBY).
 *   - MongoDB: mock toàn bộ Mongoose model (không có real DB).
 *   - NestJS TestingModule (không dùng real HTTP / supertest) vì bottleneck cần
 *     kiểm tra ở service layer, nơi Redis counter logic nằm.
 */

import { BadRequestException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";

import { BookingService } from "../booking.service";
import { Booking, SeatLock } from "@src/schemas/booking.schema";
import { SeatState } from "@src/schemas/seat-state.schema";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { ZoneService } from "@src/zone/zone.service";
import { RedisService } from "@src/redis/redis.service";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { UploadService } from "@src/upload/upload.service";
import { SLOT_SOLD_KEY_PREFIX } from "../booking.constants";

// ─── Shared fixture builders ──────────────────────────────────────────────────

const DAY = 24 * 60 * 60 * 1000;

const makeSlotId = () => new Types.ObjectId();
const makeEventId = () => new Types.ObjectId();
const makeZoneId = () => new Types.ObjectId();

const makeEventDoc = (slotId: Types.ObjectId, capacity?: number) => ({
  _id: makeEventId(),
  isDeleted: false,
  status: "active",
  endDate: new Date(Date.now() + DAY),
  timeSlots: [
    {
      _id: slotId,
      label: "Ca sáng",
      startTime: new Date(Date.now() - DAY),
      endTime: new Date(Date.now() + DAY),
      ...(capacity !== undefined ? { capacity } : {}),
    },
  ],
});

const makeZoneDoc = (zoneId: Types.ObjectId, totalCapacity = 1000) => ({
  _id: zoneId,
  price: 100_000,
  hasSeating: false,
  capacity: totalCapacity,
  soldCount: 0,
  saleStartDate: null,
  saleEndDate: null,
});

const makeSession = () => ({
  withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
  endSession: jest.fn(),
});

// ─── Module builder ───────────────────────────────────────────────────────────

interface RedisClientMock {
  set: jest.Mock;
  get: jest.Mock;
  del: jest.Mock;
  eval: jest.Mock;
  sMembers: jest.Mock;
  sAdd: jest.Mock;
  expire: jest.Mock;
  incrBy: jest.Mock;
  decrBy: jest.Mock;
}

async function buildModule(redisClient: RedisClientMock) {
  const session = makeSession();

  const bookingModel: any = jest.fn().mockImplementation((data: any) => ({
    ...data,
    _id: new Types.ObjectId(),
    save: jest.fn().mockResolvedValue(undefined),
  }));
  bookingModel.db = { startSession: jest.fn().mockResolvedValue(session) };
  bookingModel.findOne = jest
    .fn()
    .mockReturnValue({ session: jest.fn().mockResolvedValue(null) });
  bookingModel.countDocuments = jest.fn().mockResolvedValue(0);
  bookingModel.find = jest.fn();
  bookingModel.aggregate = jest
    .fn()
    .mockReturnValue({ session: jest.fn().mockResolvedValue([]) });
  bookingModel.findOneAndUpdate = jest.fn();
  bookingModel.updateMany = jest.fn();
  bookingModel.deleteMany = jest.fn();

  const eventModel = { findById: jest.fn() };
  const zoneModel = {
    findOne: jest.fn(),
    findById: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn().mockResolvedValue({}),
  };

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      BookingService,
      { provide: getModelToken(Booking.name), useValue: bookingModel },
      { provide: getModelToken(Event.name), useValue: eventModel },
      { provide: getModelToken(Zone.name), useValue: zoneModel },
      { provide: getModelToken(Area.name), useValue: { findOne: jest.fn() } },
      {
        provide: getModelToken(Ticket.name),
        useValue: {
          find: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnThis(),
            session: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([]),
          }),
        },
      },
      { provide: getModelToken(Payment.name), useValue: {} },
      {
        provide: getModelToken(SeatLock.name),
        useValue: {
          insertMany: jest.fn().mockResolvedValue([]),
          deleteMany: jest.fn(),
        },
      },
      {
        provide: getModelToken(SeatState.name),
        useValue: {
          find: jest.fn().mockReturnValue({
            session: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([]),
          }),
        },
      },
      { provide: ZoneGateway, useValue: { emitZoneTicketUpdate: jest.fn() } },
      {
        provide: ZoneService,
        useValue: { invalidateZoneAvailabilityCache: jest.fn() },
      },
      { provide: RedisService, useValue: { client: redisClient } },
      { provide: PaymentService, useValue: { issueAdminRefund: jest.fn() } },
      {
        provide: MetricsService,
        useValue: {
          bookingsTotal: { inc: jest.fn() },
          bookingConflictTotal: { inc: jest.fn() },
        },
      },
      { provide: AuditService, useValue: { record: jest.fn() } },
      { provide: UploadService, useValue: { deleteQRCode: jest.fn() } },
      {
        provide: require("@src/event/event-ownership.service")
          .EventOwnershipService,
        useValue: {
          assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
          getManagedEventIds: jest.fn().mockResolvedValue([]),
        },
      },
    ],
  }).compile();

  return {
    service: module.get(BookingService),
    bookingModel,
    eventModel,
    zoneModel,
    session,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("BookingService — Concurrency & Transaction Consistency", () => {
  let redisClient: RedisClientMock;

  beforeEach(() => {
    redisClient = {
      set: jest.fn().mockResolvedValue("OK"), // user-event lock always acquired
      get: jest.fn().mockResolvedValue(null), // no blacklist, no cache
      del: jest.fn().mockResolvedValue(0),
      eval: jest.fn().mockResolvedValue(null), // lock release Lua script
      sMembers: jest.fn().mockResolvedValue([]),
      sAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      incrBy: jest.fn(),
      decrBy: jest.fn().mockResolvedValue(0),
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. CONCURRENCY STRESS TEST
  // ═══════════════════════════════════════════════════════════════════════════
  describe("Concurrency Stress Test", () => {
    /**
     * Giả lập 20 request đồng thời (Promise.all với 20 userId khác nhau).
     * Slot capacity = 5, mỗi request book 1 vé.
     *
     * Kết quả kỳ vọng:
     *   - 5 request đầu tiên gọi INCRBY → trả về 1,2,3,4,5 (≤ 5) → tạo booking thành công.
     *   - 15 request còn lại gọi INCRBY → trả về 6,7,...,20 rồi mỗi lần DECRBY ngay lập tức
     *     (rollback về 5) → throw BadRequestException "đã hết chỗ".
     *   - Tổng INCRBY = 20 lần; DECRBY = 15 lần; counter cuối = 5.
     */
    it("20 concurrent requests on capacity=5 slot: exactly 5 succeed, 15 rejected with capacity error", async () => {
      const SLOT_CAPACITY = 5;
      const TOTAL_REQUESTS = 20;

      const slotId = makeSlotId();
      const zoneId = makeZoneId();
      const eventDoc = makeEventDoc(slotId, SLOT_CAPACITY);
      const zoneDoc = makeZoneDoc(zoneId, 1000);

      // ── Shared atomic counter (simulates Redis INCRBY atomicity) ───────────
      let atomicCounter = 0;
      redisClient.incrBy.mockImplementation(
        async (_key: string, qty: number) => {
          atomicCounter += qty;
          return atomicCounter;
        }
      );
      redisClient.decrBy.mockImplementation(
        async (_key: string, qty: number) => {
          atomicCounter -= qty;
          return atomicCounter;
        }
      );

      const { service, eventModel, zoneModel } = await buildModule(redisClient);

      // ── Event mock: handles both .select().lean() and .session() ──────────
      eventModel.findById.mockImplementation(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(eventDoc) }),
        session: jest.fn().mockResolvedValue({ ...eventDoc }),
      }));

      // ── Zone mock: always has enough capacity ─────────────────────────────
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(zoneDoc),
      });
      zoneModel.findOneAndUpdate.mockResolvedValue({ ...zoneDoc, _id: zoneId });
      zoneModel.findById.mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(zoneDoc) }),
      });

      // ── Fire 20 requests from 20 different users ──────────────────────────
      const users = Array.from({ length: TOTAL_REQUESTS }, () =>
        new Types.ObjectId().toString()
      );
      const dto = {
        eventId: eventDoc._id.toString(),
        zoneId: zoneId.toString(),
        quantity: 1,
        timeSlotId: slotId.toString(),
        customerEmail: "load@test.com",
      };

      const results = await Promise.allSettled(
        users.map((uid) => service.createBooking(uid, dto as any))
      );

      // ── Assertions ────────────────────────────────────────────────────────
      const successes = results.filter((r) => r.status === "fulfilled");
      const failures = results.filter((r) => r.status === "rejected");
      const capacityErrors = failures.filter(
        (r) =>
          r.status === "rejected" &&
          r.reason instanceof BadRequestException &&
          r.reason.message.includes("đã hết chỗ")
      );

      // Exactly SLOT_CAPACITY bookings created
      expect(successes).toHaveLength(SLOT_CAPACITY);

      // Remaining requests all rejected with capacity error (not some other error)
      expect(capacityErrors).toHaveLength(TOTAL_REQUESTS - SLOT_CAPACITY);

      // Redis INCRBY called once per request
      expect(redisClient.incrBy).toHaveBeenCalledTimes(TOTAL_REQUESTS);

      // DECRBY called exactly for each rejected-by-capacity request
      expect(redisClient.decrBy).toHaveBeenCalledTimes(
        TOTAL_REQUESTS - SLOT_CAPACITY
      );

      // All INCRBY/DECRBY calls used the correct counter key
      expect(redisClient.incrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        1
      );
      expect(redisClient.decrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        1
      );

      // Final counter equals exactly the slot capacity (no over-booking)
      expect(atomicCounter).toBe(SLOT_CAPACITY);
    });

    it("slot without capacity: all 20 requests proceed past Redis check (no INCRBY called)", async () => {
      const TOTAL_REQUESTS = 20;
      const slotId = makeSlotId();
      const zoneId = makeZoneId();
      // Slot without capacity → unlimited
      const eventDoc = makeEventDoc(slotId, undefined);
      const zoneDoc = makeZoneDoc(zoneId, 1000);

      const { service, eventModel, zoneModel } = await buildModule(redisClient);

      eventModel.findById.mockImplementation(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(eventDoc) }),
        session: jest.fn().mockResolvedValue({ ...eventDoc }),
      }));
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(zoneDoc),
      });
      zoneModel.findOneAndUpdate.mockResolvedValue({ ...zoneDoc, _id: zoneId });
      zoneModel.findById.mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(zoneDoc) }),
      });

      const dto = {
        eventId: eventDoc._id.toString(),
        zoneId: zoneId.toString(),
        quantity: 1,
        timeSlotId: slotId.toString(),
        customerEmail: "load@test.com",
      };
      const users = Array.from({ length: TOTAL_REQUESTS }, () =>
        new Types.ObjectId().toString()
      );

      const results = await Promise.allSettled(
        users.map((uid) => service.createBooking(uid, dto as any))
      );

      const successes = results.filter((r) => r.status === "fulfilled");
      expect(successes).toHaveLength(TOTAL_REQUESTS);
      // No counter involved for unlimited slots
      expect(redisClient.incrBy).not.toHaveBeenCalled();
      expect(redisClient.decrBy).not.toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. DB TRANSACTION CONSISTENCY — REDIS ROLLBACK
  // ═══════════════════════════════════════════════════════════════════════════
  describe("DB Transaction Consistency — Redis Rollback (Atomic Consistency)", () => {
    /**
     * Kịch bản: Redis INCRBY thành công (counter = 1, trong capacity).
     * Nhưng sau đó MongoDB transaction thất bại (zone hết chỗ → findOneAndUpdate null).
     *
     * Yêu cầu: catch block phải gọi DECRBY để rollback Redis counter,
     * đảm bảo counter không bị "tăng ảo" khi booking thực tế không được lưu.
     */
    it("MongoDB failure after Redis INCRBY → DECRBY called to rollback counter", async () => {
      const slotId = makeSlotId();
      const zoneId = makeZoneId();
      const eventDoc = makeEventDoc(slotId, 50); // capacity = 50

      redisClient.incrBy.mockResolvedValue(1); // 1 ≤ 50, reservation succeeds

      const { service, eventModel, zoneModel } = await buildModule(redisClient);

      eventModel.findById.mockImplementation(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(eventDoc) }),
        session: jest.fn().mockResolvedValue({ ...eventDoc }),
      }));

      // Zone findOne (inside transaction) succeeds
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(makeZoneDoc(zoneId)),
      });

      // Zone findOneAndUpdate returns null → simulates "Không đủ vé" (sold out at zone level)
      zoneModel.findOneAndUpdate.mockResolvedValue(null);

      const userId = new Types.ObjectId().toString();
      const dto = {
        eventId: eventDoc._id.toString(),
        zoneId: zoneId.toString(),
        quantity: 1,
        timeSlotId: slotId.toString(),
        customerEmail: "tx@test.com",
      };

      await expect(service.createBooking(userId, dto as any)).rejects.toThrow(
        BadRequestException
      );

      // INCRBY was called before transaction (counter reserved)
      expect(redisClient.incrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        1
      );

      // DECRBY MUST be called in catch block to rollback (atomic consistency)
      expect(redisClient.decrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        1
      );

      // DECRBY called exactly once (no double-rollback)
      expect(redisClient.decrBy).toHaveBeenCalledTimes(1);
    });

    it("MongoDB failure DOES NOT call DECRBY when slot has no capacity (counter was never reserved)", async () => {
      const slotId = makeSlotId();
      const zoneId = makeZoneId();
      // No capacity on slot → INCRBY never called, slotCapacityReserved stays false
      const eventDoc = makeEventDoc(slotId, undefined);

      const { service, eventModel, zoneModel } = await buildModule(redisClient);

      eventModel.findById.mockImplementation(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(eventDoc) }),
        session: jest.fn().mockResolvedValue({ ...eventDoc }),
      }));

      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(makeZoneDoc(zoneId)),
      });

      // Simulate MongoDB failure
      zoneModel.findOneAndUpdate.mockResolvedValue(null);

      const userId = new Types.ObjectId().toString();
      const dto = {
        eventId: eventDoc._id.toString(),
        zoneId: zoneId.toString(),
        quantity: 1,
        timeSlotId: slotId.toString(),
        customerEmail: "tx@test.com",
      };

      await expect(service.createBooking(userId, dto as any)).rejects.toThrow(
        BadRequestException
      );

      // No counter reserved → no rollback needed
      expect(redisClient.incrBy).not.toHaveBeenCalled();
      expect(redisClient.decrBy).not.toHaveBeenCalled();
    });

    it("Redis INCRBY exceeds capacity → DECRBY called immediately (before any DB ops)", async () => {
      const slotId = makeSlotId();
      const zoneId = makeZoneId();
      const CAPACITY = 3;
      const eventDoc = makeEventDoc(slotId, CAPACITY);

      // Counter already at capacity → INCRBY returns capacity + 1
      redisClient.incrBy.mockResolvedValue(CAPACITY + 1);

      const { service, eventModel, zoneModel } = await buildModule(redisClient);

      eventModel.findById.mockImplementation(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(eventDoc) }),
        session: jest.fn().mockResolvedValue({ ...eventDoc }),
      }));

      const userId = new Types.ObjectId().toString();
      const dto = {
        eventId: eventDoc._id.toString(),
        zoneId: zoneId.toString(),
        quantity: 1,
        timeSlotId: slotId.toString(),
        customerEmail: "tx@test.com",
      };

      await expect(service.createBooking(userId, dto as any)).rejects.toThrow(
        /đã hết chỗ/i
      );

      // Rollback happened BEFORE entering the transaction
      expect(redisClient.decrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        1
      );

      // DB was never touched (zone findOneAndUpdate not called)
      expect(zoneModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("booking quantity > 1 is rolled back with the exact quantity", async () => {
      const slotId = makeSlotId();
      const zoneId = makeZoneId();
      const CAPACITY = 5;
      const QUANTITY = 3;
      const eventDoc = makeEventDoc(slotId, CAPACITY);

      // Counter would exceed: INCRBY 3 on a counter already at 4 → returns 7 > 5
      redisClient.incrBy.mockResolvedValue(7);

      const { service, eventModel } = await buildModule(redisClient);

      eventModel.findById.mockImplementation(() => ({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(eventDoc) }),
        session: jest.fn().mockResolvedValue({ ...eventDoc }),
      }));

      const userId = new Types.ObjectId().toString();
      const dto = {
        eventId: eventDoc._id.toString(),
        zoneId: zoneId.toString(),
        quantity: QUANTITY,
        timeSlotId: slotId.toString(),
        customerEmail: "tx@test.com",
      };

      await expect(service.createBooking(userId, dto as any)).rejects.toThrow(
        BadRequestException
      );

      // DECRBY must use the same quantity as INCRBY
      expect(redisClient.incrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        QUANTITY
      );
      expect(redisClient.decrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        QUANTITY
      );
    });
  });
});
