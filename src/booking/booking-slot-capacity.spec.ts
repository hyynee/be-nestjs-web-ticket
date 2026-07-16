/**
 * Unit tests: Slot Capacity Enforcement via Redis atomic counter.
 * Kiểm tra logic INCRBY / DECRBY rollback trong createBooking.
 */
import { BadRequestException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import { BookingService } from "./booking.service";
import { BookingWorkflowService } from "./application/booking-workflow.service";
import { BookingCommandService } from "./application/booking-command.service";
import { BookingMutationService } from "./application/use-case/booking-mutation.use-case";
import { CreateBookingUseCase } from "./application/use-case/create-booking.use-case";
import { CancelBookingUseCase } from "./application/use-case/cancel-booking.use-case";
import { AdminCancelBookingUseCase } from "./application/use-case/admin-cancel-booking.use-case";
import { BookingQueryService } from "./application/booking-query.service";
import { BookingMaintenanceService } from "./application/booking-maintenance.service";
import { BookingCacheService } from "./infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "./infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "./presenters/booking.presenter";
import { BookingCodeService } from "./domain/services/booking-code.service";
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
import { SLOT_SOLD_KEY_PREFIX } from "./booking.constants";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const HOUR = 60 * 60 * 1000;

const slotId = new Types.ObjectId();
const eventId = new Types.ObjectId().toString();
const zoneId = new Types.ObjectId().toString();
const userId = new Types.ObjectId().toString();

const makeSlot = (capacity?: number) => ({
  _id: slotId,
  label: "Ca sáng",
  startTime: new Date(Date.now() - HOUR),
  endTime: new Date(Date.now() + HOUR),
  ...(capacity !== undefined ? { capacity } : {}),
});

const makeEvent = (capacity?: number) => ({
  _id: new Types.ObjectId(eventId),
  isDeleted: false,
  status: "active",
  endDate: new Date(Date.now() + 24 * HOUR),
  timeSlots: [makeSlot(capacity)],
});

const makeZone = () => ({
  _id: new Types.ObjectId(zoneId),
  price: 100,
  hasSeating: false,
  capacity: 200,
  soldCount: 0,
  saleStartDate: null,
  saleEndDate: null,
});

const makeCreateDto = () => ({
  eventId,
  zoneId,
  quantity: 2,
  timeSlotId: slotId.toString(),
  customerEmail: "test@example.com",
});

// ─── Test setup ──────────────────────────────────────────────────────────────

describe("BookingService — Slot Capacity", () => {
  let service: BookingService;
  let eventModel: { findById: jest.Mock };
  let zoneModel: {
    findOne: jest.Mock;
    findById: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateOne: jest.Mock;
  };
  let bookingModel: jest.Mock & {
    db: { startSession: jest.Mock };
    findOne: jest.Mock;
    countDocuments: jest.Mock;
  };
  let redisClient: {
    set: jest.Mock;
    get: jest.Mock;
    del: jest.Mock;
    eval: jest.Mock;
    sMembers: jest.Mock;
    sAdd: jest.Mock;
    expire: jest.Mock;
    incrBy: jest.Mock;
    decrBy: jest.Mock;
  };

  const makeSession = () => ({
    withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
    endSession: jest.fn(),
  });

  beforeEach(async () => {
    redisClient = {
      set: jest.fn().mockResolvedValue("OK"),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(0),
      eval: jest.fn().mockResolvedValue(null),
      sMembers: jest.fn().mockResolvedValue([]),
      sAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
      incrBy: jest.fn(),
      decrBy: jest.fn().mockResolvedValue(0),
    };

    const session = makeSession();

    bookingModel = Object.assign(
      jest.fn().mockImplementation(() => ({
        _id: new Types.ObjectId(),
        save: jest.fn().mockResolvedValue(undefined),
        bookingCode: "BK-TEST",
      })),
      {
        db: { startSession: jest.fn().mockResolvedValue(session) },
        findOne: jest
          .fn()
          .mockReturnValue({ session: jest.fn().mockResolvedValue(null) }),
        countDocuments: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        find: jest.fn(),
        aggregate: jest
          .fn()
          .mockReturnValue({ session: jest.fn().mockResolvedValue([]) }),
        findOneAndUpdate: jest.fn(),
      }
    );

    eventModel = {
      findById: jest.fn(),
    };

    const zoneDoc = makeZone();
    zoneModel = {
      findOne: jest.fn(),
      findById: jest.fn().mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(zoneDoc) }),
        session: jest.fn().mockResolvedValue(zoneDoc),
      }),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
        BookingWorkflowService,
        BookingCommandService,
        BookingMutationService,
        CreateBookingUseCase,
        CancelBookingUseCase,
        AdminCancelBookingUseCase,
        BookingQueryService,
        BookingMaintenanceService,
        BookingCacheService,
        BookingZoneNotifierService,
        BookingPresenter,
        BookingCodeService,
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

    service = module.get(BookingService);
  });

  // ── Helper: set up event pre-fetch and transaction event mock ──────────────

  const setupEventMocks = (capacity?: number) => {
    // Pre-fetch (select + lean — used for capacity check)
    const leanResult = makeEvent(capacity);
    eventModel.findById.mockImplementation(() => ({
      select: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue(leanResult) }),
      // session call inside withTransaction
      session: jest.fn().mockResolvedValue({
        ...leanResult,
        timeSlots: leanResult.timeSlots,
      }),
    }));

    zoneModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(makeZone()),
    });

    zoneModel.findOneAndUpdate.mockReturnValue(
      Promise.resolve({ _id: new Types.ObjectId(zoneId) })
    );
  };

  // ── Tests ─────────────────────────────────────────────────────────────────

  describe("slot with capacity enforcement", () => {
    it("rejects booking when slot is at full capacity", async () => {
      setupEventMocks(50);
      // INCRBY returns 52 (50 existing + 2 requested) > capacity 50
      redisClient.incrBy.mockResolvedValue(52);

      await expect(
        service.createBooking(userId, makeCreateDto())
      ).rejects.toThrow(/đã hết chỗ/i);

      expect(redisClient.incrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        2
      );
      // Rollback: DECRBY must be called when capacity is exceeded
      expect(redisClient.decrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        2
      );
    });

    it("proceeds when slot has available capacity", async () => {
      setupEventMocks(50);
      // INCRBY returns 2 (first 2 tickets) ≤ 50
      redisClient.incrBy.mockResolvedValue(2);

      const result = await service.createBooking(userId, makeCreateDto());

      expect(result?.success).toBe(true);
      expect(redisClient.incrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        2
      );
      // DECRBY should NOT be called on success
      expect(redisClient.decrBy).not.toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        2
      );
    });

    it("sets TTL on slot counter after successful INCRBY", async () => {
      setupEventMocks(50);
      redisClient.incrBy.mockResolvedValue(2);

      await service.createBooking(userId, makeCreateDto());

      expect(redisClient.expire).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        expect.any(Number)
      );
    });

    it("rollbacks slot counter when MongoDB transaction fails", async () => {
      setupEventMocks(50);
      redisClient.incrBy.mockResolvedValue(2);

      // Make the zone findOneAndUpdate fail (simulate "Không đủ vé")
      zoneModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.createBooking(userId, makeCreateDto())
      ).rejects.toThrow(BadRequestException);

      // Counter must be rolled back in catch block
      expect(redisClient.decrBy).toHaveBeenCalledWith(
        `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
        2
      );
    });
  });

  describe("slot without capacity (unlimited)", () => {
    it("skips Redis counter when slot has no capacity set", async () => {
      setupEventMocks(undefined); // no capacity
      // Make zone + booking succeed
      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });

      await service.createBooking(userId, makeCreateDto());

      // incrBy should NOT be called when capacity is undefined
      expect(redisClient.incrBy).not.toHaveBeenCalled();
    });
  });

  describe("booking without timeSlotId", () => {
    it("skips all slot capacity checks entirely", async () => {
      // Event has no slots
      eventModel.findById.mockImplementation(() => ({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(eventId),
            isDeleted: false,
            status: "active",
            endDate: new Date(Date.now() + 24 * HOUR),
            timeSlots: [],
          }),
        }),
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "active",
          endDate: new Date(Date.now() + 24 * HOUR),
          timeSlots: [],
        }),
      }));
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(makeZone()),
      });
      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });

      const dto = { ...makeCreateDto(), timeSlotId: undefined };
      await service.createBooking(userId, dto);

      expect(redisClient.incrBy).not.toHaveBeenCalled();
    });
  });
});
