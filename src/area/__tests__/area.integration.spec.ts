/**
 * Area Integration Tests — real MongoDB transactions (P1)
 *
 * Chạy trên `MongoMemoryReplSet` (transactions cần replica set, không chạy được trên
 * mongod đơn lẻ). Gated bởi RUN_AREA_INTEGRATION=true để không làm chậm `pnpm test`
 * mặc định — CI/dev bật khi cần verify transaction/rollback behavior thật.
 *
 * Không dùng mock session — mục tiêu là chứng minh:
 *   - Rollback đầy đủ khi transaction fail giữa chừng (capacity + area document).
 *   - Conditional capacity update thực sự chặn khi dữ liệu không đủ, không chỉ ở mock.
 *   - Cross-event move bị chặn end-to-end với dữ liệu Event/Zone/Area thật.
 *   - Event status allowlist (DRAFT/INACTIVE) được enforce với dữ liệu thật.
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { MongooseModule, getConnectionToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { Connection, Types } from "mongoose";

import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { Area, AreaSchema } from "@src/schemas/area.schema";
import {
  Booking,
  BookingSchema,
  BookingStatus,
} from "@src/schemas/booking.schema";
import { Event, EventSchema, EventStatus } from "@src/schemas/event.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { ZoneService } from "@src/zone/zone.service";

import { AreaCommandService } from "../application/area-command.service";
import { AreaMutationPolicy } from "../domain/policies/area-mutation.policy";
import { AreaCacheService } from "../infrastructure/cache/area-cache.service";
import { AreaRepository } from "../infrastructure/persistence/area.repository";
import { AreaPresenter } from "../presenters/area.presenter";

const shouldRun = process.env.RUN_AREA_INTEGRATION === "true";
const describeIntegration = shouldRun ? describe : describe.skip;

const ADMIN_USER: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};

let replSet: MongoMemoryReplSet;
let moduleRef: TestingModule;
let connection: Connection;
let areaCommandService: AreaCommandService;
let eventModel: any;
let zoneModel: any;
let areaModel: any;
let bookingModel: any;

const mockAreaCacheService = {
  invalidateAreaCache: jest.fn().mockResolvedValue(undefined),
  getAreaDetail: jest.fn(),
  getAreaList: jest.fn(),
};

const mockZoneService = {
  invalidateZoneAvailabilityCache: jest.fn().mockResolvedValue(undefined),
};

const mockMetricsService = {
  zoneCapacityInconsistentTotal: { inc: jest.fn() },
  cacheInvalidationFailureTotal: { inc: jest.fn() },
};

beforeAll(async () => {
  if (!shouldRun) {
    return;
  }

  replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  const uri = replSet.getUri();

  moduleRef = await Test.createTestingModule({
    imports: [
      MongooseModule.forRoot(uri, { dbName: "area_integration_test" }),
      MongooseModule.forFeature([
        { name: Area.name, schema: AreaSchema },
        { name: Zone.name, schema: ZoneSchema },
        { name: Booking.name, schema: BookingSchema },
        { name: Event.name, schema: EventSchema },
      ]),
    ],
    providers: [
      AreaCommandService,
      AreaRepository,
      AreaMutationPolicy,
      AreaPresenter,
      { provide: AreaCacheService, useValue: mockAreaCacheService },
      { provide: ZoneService, useValue: mockZoneService },
      { provide: MetricsService, useValue: mockMetricsService },
      {
        provide: EventOwnershipService,
        useValue: {
          assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
        },
      },
    ],
  }).compile();

  connection = moduleRef.get(getConnectionToken());
  areaCommandService = moduleRef.get(AreaCommandService);
  eventModel = connection.model(Event.name);
  zoneModel = connection.model(Zone.name);
  areaModel = connection.model(Area.name);
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
    areaModel.deleteMany({}),
    bookingModel.deleteMany({}),
  ]);
  jest.clearAllMocks();
});

const seedEvent = (overrides: Partial<Record<string, unknown>> = {}) =>
  eventModel.create({
    title: "Integration Test Event",
    startDate: new Date(Date.now() + 86_400_000),
    endDate: new Date(Date.now() + 172_800_000),
    location: "Test Venue",
    status: EventStatus.DRAFT,
    createdBy: new Types.ObjectId(ADMIN_USER.userId),
    ...overrides,
  });

const seedZone = (
  eventId: Types.ObjectId,
  overrides: Partial<Record<string, unknown>> = {}
) =>
  zoneModel.create({
    eventId,
    name: `Zone-${new Types.ObjectId().toHexString()}`,
    price: 100_000,
    capacity: 100,
    currentTotalSeats: 0,
    hasSeating: true,
    isDeleted: false,
    ...overrides,
  });

describeIntegration("AreaCommandService — real Mongo transactions", () => {
  describe("createArea: rollback on failure", () => {
    it("rolls back zone capacity increment when area insert fails (duplicate name)", async () => {
      const event = await seedEvent();
      const zone = await seedZone(event._id);

      // Pre-existing active area occupies the name "VIP" in this zone.
      await areaModel.create({
        eventId: event._id,
        zoneId: zone._id,
        name: "VIP",
        seatCount: 5,
        seats: ["A1", "A2", "A3", "A4", "A5"],
        isDeleted: false,
      });
      await zoneModel.updateOne(
        { _id: zone._id },
        { $set: { currentTotalSeats: 5 } }
      );

      await expect(
        areaCommandService.createArea(ADMIN_USER, {
          zoneId: zone._id.toString(),
          name: "vip",
          seatCount: 3,
          rowLabel: "B",
        } as any)
      ).rejects.toThrow(ConflictException);

      const zoneAfter = await zoneModel.findById(zone._id).lean();
      expect(zoneAfter!.currentTotalSeats).toBe(5);

      const areaCount = await areaModel.countDocuments({ zoneId: zone._id });
      expect(areaCount).toBe(1);
    });
  });

  describe("incrementZoneCapacity: conditional update, no clamp", () => {
    it("throws and leaves state unchanged when decrement would go below zero (drifted counter)", async () => {
      const event = await seedEvent();
      const zone = await seedZone(event._id, { currentTotalSeats: 2 });

      const area = await areaModel.create({
        eventId: event._id,
        zoneId: zone._id,
        name: "DRIFTED",
        seatCount: 5,
        seats: ["A1", "A2", "A3", "A4", "A5"],
        isDeleted: false,
      });

      await expect(
        areaCommandService.softDeleteArea(ADMIN_USER, area._id.toString(), {
          isDeleted: true,
        })
      ).rejects.toThrow(ConflictException);

      const zoneAfter = await zoneModel.findById(zone._id).lean();
      expect(zoneAfter!.currentTotalSeats).toBe(2);

      const areaAfter = await areaModel.findById(area._id).lean();
      expect(areaAfter!.isDeleted).toBe(false);
    });

    it("succeeds and decrements exactly when counter is consistent", async () => {
      const event = await seedEvent();
      const zone = await seedZone(event._id, { currentTotalSeats: 5 });

      const area = await areaModel.create({
        eventId: event._id,
        zoneId: zone._id,
        name: "CLEAN",
        seatCount: 5,
        seats: ["A1", "A2", "A3", "A4", "A5"],
        isDeleted: false,
      });

      await areaCommandService.softDeleteArea(ADMIN_USER, area._id.toString(), {
        isDeleted: true,
      });

      const zoneAfter = await zoneModel.findById(zone._id).lean();
      expect(zoneAfter!.currentTotalSeats).toBe(0);
    });
  });

  describe("updateArea: cross-event move forbidden", () => {
    it("rejects moving an area to a zone in a different event and leaves everything unchanged", async () => {
      const eventA = await seedEvent();
      const eventB = await seedEvent();
      const zoneA = await seedZone(eventA._id, { currentTotalSeats: 3 });
      const zoneB = await seedZone(eventB._id, { currentTotalSeats: 0 });

      const area = await areaModel.create({
        eventId: eventA._id,
        zoneId: zoneA._id,
        name: "MOVABLE",
        seatCount: 3,
        seats: ["A1", "A2", "A3"],
        isDeleted: false,
      });

      await expect(
        areaCommandService.updateArea(ADMIN_USER, area._id.toString(), {
          zoneId: zoneB._id.toString(),
        } as any)
      ).rejects.toThrow(ConflictException);

      const areaAfter = await areaModel.findById(area._id).lean();
      expect(areaAfter!.zoneId.toString()).toBe(zoneA._id.toString());
      expect(areaAfter!.eventId.toString()).toBe(eventA._id.toString());

      const zoneAAfter = await zoneModel.findById(zoneA._id).lean();
      const zoneBAfter = await zoneModel.findById(zoneB._id).lean();
      expect(zoneAAfter!.currentTotalSeats).toBe(3);
      expect(zoneBAfter!.currentTotalSeats).toBe(0);
    });
  });

  describe("event status allowlist", () => {
    it.each([EventStatus.ACTIVE, EventStatus.ENDED, EventStatus.CANCELLED])(
      "rejects area creation when event status is %s",
      async (status) => {
        const event = await seedEvent({ status });
        const zone = await seedZone(event._id);

        await expect(
          areaCommandService.createArea(ADMIN_USER, {
            zoneId: zone._id.toString(),
            name: "BLOCKED",
            seatCount: 2,
            rowLabel: "A",
          } as any)
        ).rejects.toThrow(ConflictException);

        const areaCount = await areaModel.countDocuments({ zoneId: zone._id });
        expect(areaCount).toBe(0);
      }
    );

    it.each([EventStatus.DRAFT, EventStatus.INACTIVE])(
      "allows area creation when event status is %s",
      async (status) => {
        const event = await seedEvent({ status });
        const zone = await seedZone(event._id);

        const result = await areaCommandService.createArea(ADMIN_USER, {
          zoneId: zone._id.toString(),
          name: "ALLOWED",
          seatCount: 2,
          rowLabel: "A",
        } as any);

        expect(result.name).toBe("ALLOWED");
      }
    );
  });

  describe("softDeleteArea: active booking guard", () => {
    it("rejects delete when an active booking references the area", async () => {
      const event = await seedEvent();
      const zone = await seedZone(event._id, { currentTotalSeats: 2 });

      const area = await areaModel.create({
        eventId: event._id,
        zoneId: zone._id,
        name: "BOOKED",
        seatCount: 2,
        seats: ["A1", "A2"],
        isDeleted: false,
      });

      await bookingModel.create({
        bookingCode: `BK-${Date.now()}`,
        userId: new Types.ObjectId(),
        eventId: event._id,
        zoneId: zone._id,
        areaId: area._id,
        seats: ["A1"],
        quantity: 1,
        pricePerTicket: 100_000,
        totalPrice: 100_000,
        status: BookingStatus.CONFIRMED,
        customerEmail: "integration@test.local",
        expiresAt: new Date(Date.now() + 3_600_000),
        isDeleted: false,
      });

      await expect(
        areaCommandService.softDeleteArea(ADMIN_USER, area._id.toString(), {
          isDeleted: true,
        })
      ).rejects.toThrow(ConflictException);

      const areaAfter = await areaModel.findById(area._id).lean();
      expect(areaAfter!.isDeleted).toBe(false);

      const zoneAfter = await zoneModel.findById(zone._id).lean();
      expect(zoneAfter!.currentTotalSeats).toBe(2);
    });
  });

  describe("softDeleteArea: restore validates zone", () => {
    it("rejects restore when the zone was soft-deleted in the meantime", async () => {
      const event = await seedEvent();
      const zone = await seedZone(event._id, { currentTotalSeats: 2 });

      const area = await areaModel.create({
        eventId: event._id,
        zoneId: zone._id,
        name: "ORPHAN",
        seatCount: 2,
        seats: ["A1", "A2"],
        isDeleted: true,
      });

      await zoneModel.updateOne(
        { _id: zone._id },
        { $set: { isDeleted: true } }
      );

      await expect(
        areaCommandService.softDeleteArea(ADMIN_USER, area._id.toString(), {
          isDeleted: false,
        })
      ).rejects.toThrow(NotFoundException);

      const areaAfter = await areaModel.findById(area._id).lean();
      expect(areaAfter!.isDeleted).toBe(true);
    });
  });
});
