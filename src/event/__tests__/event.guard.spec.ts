/**
 * Integration Tests: Admin Safety Guard & Edge Case Validation
 *
 * 1. Admin Safety Guard — EventService.updateEvent chặn xóa slot có booking active
 * 2. Check-in Time Window — validateTimeSlotWindow (pure function) kiểm tra biên thời gian
 * 3. Check-in Integration — TicketService.validateTicket với timeSlotId
 * 4. Slot Capacity Boundary — BookingService từ chối booking khi slot đầy
 */

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";

import { EventService } from "../event.service";
import { BookingService } from "@src/booking/booking.service";
import {
  validateTimeSlotWindow,
  TicketService,
} from "@src/ticket/ticket.service";
import { ticketTestProviders } from "@src/ticket/testing/ticket-test.providers";

import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Booking, SeatLock } from "@src/schemas/booking.schema";
import { SeatState } from "@src/schemas/seat-state.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { CheckInLog } from "@src/schemas/checkin-log.schema";
import { User } from "@src/schemas/user.schema";
import { EventOwnershipService } from "../event-ownership.service";

import { ZoneGateway } from "@src/zone/zone.gateway";
import { ZoneService } from "@src/zone/zone.service";
import { TicketGateway } from "@src/ticket/ticket.gateway";
import { RedisService } from "@src/redis/redis.service";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { UploadService } from "@src/upload/upload.service";
import { NotificationService } from "@src/notification/notification.service";
import { SLOT_SOLD_KEY_PREFIX } from "@src/booking/booking.constants";
import { EventCacheService } from "../infrastructure/cache/event-cache.service";
import { EventRepository } from "../infrastructure/persistence/event.repository";
import { EventPresenter } from "../presenters/event.presenter";
import { EventPublishPolicy } from "../domain/policies/event-publish.policy";
import { EventTimeSlotPolicy } from "../domain/policies/event-time-slot.policy";
import { EventCommandService } from "../application/event-command.service";
import { EventLifecycleService } from "../application/event-lifecycle.service";
import { EventMemberService } from "../application/event-member.service";
import { EventQueryService } from "../application/event-query.service";
import { BookingCommandService } from "@src/booking/application/booking-command.service";
import { BookingMaintenanceService } from "@src/booking/application/booking-maintenance.service";
import { BookingQueryService } from "@src/booking/application/booking-query.service";
import { AdminCancelBookingUseCase } from "@src/booking/application/use-case/admin-cancel-booking.use-case";
import { BookingMutationService } from "@src/booking/application/use-case/booking-mutation.use-case";
import { CancelBookingUseCase } from "@src/booking/application/use-case/cancel-booking.use-case";
import { CreateBookingUseCase } from "@src/booking/application/use-case/create-booking.use-case";
import { BookingCodeService } from "@src/booking/domain/services/booking-code.service";
import { BookingCacheService } from "@src/booking/infrastructure/cache/booking-cache.service";
import { BookingZoneNotifierService } from "@src/booking/infrastructure/realtime/booking-zone-notifier.service";
import { BookingPresenter } from "@src/booking/presenters/booking.presenter";
import { PromotionService } from "@src/promotion/promotion.service";

// ─── Shared helpers ──────────────────────────────────────────────────────────
const HOUR_MS = 60 * 60 * 1000;
const GRACE_MS = 30 * 60 * 1000; // must match CHECKIN_GRACE_MS in ticket.service.ts

const makeSlot = (overrides: Record<string, unknown> = {}) => {
  const id = new Types.ObjectId();
  return {
    _id: id,
    label: `Ca ${id.toString().slice(-4)}`,
    startTime: new Date(Date.now() + HOUR_MS),
    endTime: new Date(Date.now() + 3 * HOUR_MS),
    ...overrides,
  };
};

// ═══════════════════════════════════════════════════════════════════════════════
// 1. ADMIN SAFETY GUARD — EventService.updateEvent
// ═══════════════════════════════════════════════════════════════════════════════
describe("Admin Safety Guard — EventService.updateEvent slot deletion", () => {
  let eventService: EventService;
  let eventModel: jest.Mocked<any>;
  let bookingModel: jest.Mocked<any>;
  let mockRedisClient: any;

  const adminUser = { userId: new Types.ObjectId().toString(), role: "admin" };
  const eventId = new Types.ObjectId().toString();

  beforeEach(async () => {
    mockRedisClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      del: jest.fn().mockResolvedValue(0),
      sAdd: jest.fn().mockResolvedValue(1),
      sMembers: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
    };

    eventModel = Object.assign(
      jest.fn().mockImplementation((data: any) => ({
        ...data,
        _id: new Types.ObjectId(),
        save: jest
          .fn()
          .mockResolvedValue({ ...data, _id: new Types.ObjectId() }),
      })),
      {
        findOne: jest.fn(),
        findById: jest.fn(),
        findByIdAndUpdate: jest.fn(),
        countDocuments: jest.fn(),
        find: jest.fn(),
        db: { startSession: jest.fn() },
      }
    );

    bookingModel = {
      countDocuments: jest.fn(),
      find: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventService,
        EventQueryService,
        EventCommandService,
        EventMemberService,
        EventLifecycleService,
        EventRepository,
        EventCacheService,
        EventPresenter,
        EventPublishPolicy,
        EventTimeSlotPolicy,
        { provide: getModelToken(Event.name), useValue: eventModel },
        {
          provide: getModelToken(Zone.name),
          useValue: { aggregate: jest.fn(), updateMany: jest.fn() },
        },
        {
          provide: getModelToken(Area.name),
          useValue: { updateMany: jest.fn() },
        },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        {
          provide: getModelToken(User.name),
          useValue: { findById: jest.fn(), updateOne: jest.fn() },
        },
        {
          provide: CACHE_MANAGER,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
        },
        {
          provide: BookingService,
          useValue: { adminCancelBooking: jest.fn() },
        },
        { provide: RedisService, useValue: { client: mockRedisClient } },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    eventService = module.get(EventService);
  });

  it("Scenario A (Negative): removing slot with active booking → 400 with slot details", async () => {
    const slotA = makeSlot({ label: "Ca Sáng" });
    const slotB = makeSlot({ label: "Ca Chiều" });

    const existingEvent = {
      _id: new Types.ObjectId(eventId),
      isDeleted: false,
      startDate: new Date(Date.now() - HOUR_MS),
      endDate: new Date(Date.now() + 5 * HOUR_MS),
      timeSlots: [slotA, slotB],
    };

    eventModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(existingEvent),
    });

    // Slot A has 2 active bookings, slot B has 0
    bookingModel.countDocuments.mockImplementation((filter: any) => {
      const filterSlotId =
        filter?.timeSlotId?.toString?.() ?? String(filter?.timeSlotId);
      return Promise.resolve(filterSlotId === slotA._id.toString() ? 2 : 0);
    });

    // Send update that keeps only slot B (removes slot A)
    const updateDto = {
      timeSlots: [
        {
          _id: slotB._id.toString(),
          label: slotB.label,
          startTime: slotB.startTime,
          endTime: slotB.endTime,
        },
      ],
    };

    let caughtError: BadRequestException | undefined;
    try {
      await eventService.updateEvent(
        adminUser as any,
        eventId,
        updateDto as any
      );
    } catch (e) {
      caughtError = e as BadRequestException;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect(caughtError!.message).toContain(
      "Không thể xóa khung giờ đang có vé đặt"
    );
    expect(caughtError!.message).toContain("Ca Sáng");
    expect(caughtError!.message).toContain("2 vé");
    expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it("Scenario B (Positive): removing slot with zero active bookings → success", async () => {
    const slotA = makeSlot({ label: "Ca Sáng" });
    const slotB = makeSlot({ label: "Ca Chiều" });

    const existingEvent = {
      _id: new Types.ObjectId(eventId),
      isDeleted: false,
      startDate: new Date(Date.now() - HOUR_MS),
      endDate: new Date(Date.now() + 5 * HOUR_MS),
      timeSlots: [slotA, slotB],
    };

    eventModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(existingEvent),
    });

    // Zero bookings for all slots
    bookingModel.countDocuments.mockResolvedValue(0);

    const updatedDoc = {
      _id: new Types.ObjectId(eventId),
      timeSlots: [slotB],
    };
    eventModel.findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(updatedDoc),
    });

    const result = await eventService.updateEvent(adminUser as any, eventId, {
      timeSlots: [
        {
          _id: slotB._id.toString(),
          label: slotB.label,
          startTime: slotB.startTime,
          endTime: slotB.endTime,
        },
      ],
    } as any);

    // Slot A removed, only slot B remains
    expect(result.timeSlots).toHaveLength(1);
    expect(result.timeSlots[0].id).toBe(slotB._id.toString());
    expect(bookingModel.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ timeSlotId: slotA._id })
    );
  });

  it("Scenario C: updating slot label without removing any → no booking check, immediate update", async () => {
    const slotA = makeSlot({ label: "Ca Cũ" });

    const existingEvent = {
      _id: new Types.ObjectId(eventId),
      isDeleted: false,
      startDate: new Date(Date.now() - HOUR_MS),
      endDate: new Date(Date.now() + 5 * HOUR_MS),
      timeSlots: [slotA],
    };

    eventModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(existingEvent),
    });

    const updatedDoc = {
      _id: new Types.ObjectId(eventId),
      timeSlots: [{ ...slotA, label: "Ca Mới" }],
    };
    eventModel.findByIdAndUpdate.mockReturnValue({
      exec: jest.fn().mockResolvedValue(updatedDoc),
    });

    const result = await eventService.updateEvent(adminUser as any, eventId, {
      timeSlots: [
        {
          _id: slotA._id.toString(),
          label: "Ca Mới",
          startTime: slotA.startTime,
          endTime: slotA.endTime,
        },
      ],
    } as any);

    // No slots removed → countDocuments never called for booking guard
    expect(bookingModel.countDocuments).not.toHaveBeenCalled();
    expect(result.timeSlots[0].label).toBe("Ca Mới");
  });

  it("Scenario D: event not found → NotFoundException", async () => {
    eventModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(null),
    });

    await expect(
      eventService.updateEvent(adminUser as any, eventId, {
        timeSlots: [],
      } as any)
    ).rejects.toThrow(NotFoundException);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. CHECK-IN TIME WINDOW — Pure function validateTimeSlotWindow
// ═══════════════════════════════════════════════════════════════════════════════
describe("Edge Case — Check-in Time Window (validateTimeSlotWindow pure function)", () => {
  // Anchor times for deterministic tests
  const slotStart = new Date("2026-06-10T09:00:00.000Z");
  const slotEnd = new Date("2026-06-10T12:00:00.000Z");
  const slot = {
    _id: new Types.ObjectId(),
    label: "Ca Sáng Test",
    startTime: slotStart,
    endTime: slotEnd,
  };

  it("35 phút trước giờ bắt đầu → invalid, message chứa 'Chưa tới giờ check-in'", () => {
    const now = new Date(slotStart.getTime() - 35 * 60 * 1000);
    const result = validateTimeSlotWindow(slot, now);

    expect(result.valid).toBe(false);
    expect(result.message).toContain("Chưa tới giờ check-in");
    expect(result.message).toContain(slot.label);
  });

  it("đúng tại điểm bắt đầu grace period (30 phút trước startTime) → valid", () => {
    // now = startTime - 30min → earliest = startTime - 30min → now === earliest → NOT < earliest
    const now = new Date(slotStart.getTime() - GRACE_MS);
    const result = validateTimeSlotWindow(slot, now);

    expect(result.valid).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it("1 phút trước giờ bắt đầu (trong grace period) → valid", () => {
    const now = new Date(slotStart.getTime() - 60 * 1000);
    const result = validateTimeSlotWindow(slot, now);

    expect(result.valid).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it("đúng giờ bắt đầu slot → valid", () => {
    const result = validateTimeSlotWindow(slot, slotStart);

    expect(result.valid).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it("giữa slot (startTime + 90 phút) → valid", () => {
    const now = new Date(slotStart.getTime() + 90 * 60 * 1000);
    const result = validateTimeSlotWindow(slot, now);

    expect(result.valid).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it("đúng giờ kết thúc slot (endTime) → valid (biên mở: now > endTime là false khi bằng)", () => {
    const result = validateTimeSlotWindow(slot, slotEnd);

    expect(result.valid).toBe(true);
  });

  it("1ms sau giờ kết thúc → invalid, message chứa 'đã kết thúc'", () => {
    const now = new Date(slotEnd.getTime() + 1);
    const result = validateTimeSlotWindow(slot, now);

    expect(result.valid).toBe(false);
    expect(result.message).toContain("đã kết thúc");
    expect(result.message).toContain(slot.label);
  });

  it("1 tiếng sau khi slot kết thúc → invalid", () => {
    const now = new Date(slotEnd.getTime() + HOUR_MS);
    const result = validateTimeSlotWindow(slot, now);

    expect(result.valid).toBe(false);
    expect(result.message).toContain("đã kết thúc");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. CHECK-IN INTEGRATION — TicketService.validateTicket
// ═══════════════════════════════════════════════════════════════════════════════
describe("Edge Case — Check-in Integration (TicketService.validateTicket)", () => {
  let ticketService: TicketService;
  let ticketModel: jest.Mocked<any>;

  // A slot currently active (started 1 hour ago, ends in 1 hour)
  const activeSlotId = new Types.ObjectId();
  const activeSlot = {
    _id: activeSlotId,
    label: "Ca Chiều Hiện Tại",
    startTime: new Date(Date.now() - HOUR_MS),
    endTime: new Date(Date.now() + HOUR_MS),
  };

  const makeEventDoc = (
    timeSlots: any[],
    overrides: Record<string, unknown> = {}
  ) => ({
    _id: new Types.ObjectId(),
    startDate: new Date(Date.now() - 2 * HOUR_MS),
    endDate: new Date(Date.now() + 5 * HOUR_MS),
    timeSlots,
    ...overrides,
  });

  const makeTicketDoc = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    ticketCode: "TK-GUARD-001",
    status: "valid",
    isDeleted: false,
    userId: new Types.ObjectId(),
    timeSlotId: activeSlotId,
    eventId: makeEventDoc([activeSlot]),
    ...overrides,
  });

  const stubTicketFindOne = (doc: any) => {
    ticketModel.findOne.mockReturnValue({
      populate: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(doc),
      }),
    });
  };

  beforeEach(async () => {
    ticketModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      updateOne: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ...ticketTestProviders,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        {
          provide: getModelToken(Booking.name),
          useValue: { find: jest.fn(), countDocuments: jest.fn() },
        },
        {
          provide: getModelToken(Event.name),
          useValue: { findById: jest.fn() },
        },
        {
          provide: getModelToken(Zone.name),
          useValue: { findById: jest.fn() },
        },
        {
          provide: getModelToken(CheckInLog.name),
          useValue: { create: jest.fn(), insertMany: jest.fn() },
        },
        {
          provide: TicketGateway,
          useValue: {
            emitTicketCheckedIn: jest.fn(),
            emitTicketCreated: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            client: {
              get: jest.fn().mockResolvedValue(null),
              set: jest.fn().mockResolvedValue("OK"),
              del: jest.fn().mockResolvedValue(0),
              sMembers: jest.fn().mockResolvedValue([]),
              sAdd: jest.fn().mockResolvedValue(1),
              expire: jest.fn().mockResolvedValue(1),
            },
          },
        },
        {
          provide: UploadService,
          useValue: { uploadImage: jest.fn(), deleteQRCode: jest.fn() },
        },
        {
          provide: AuditService,
          useValue: { record: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
            hasCheckInAccess: jest
              .fn()
              .mockImplementation((user: any) => user.role === "admin"),
          },
        },
      ],
    }).compile();

    ticketService = module.get(TicketService);
  });

  it("vé có timeSlotId, check-in trong cửa sổ → valid: true, message 'hợp lệ'", async () => {
    const userId = new Types.ObjectId();
    stubTicketFindOne(makeTicketDoc({ userId }));

    const result = await ticketService.validateTicket("TK-GUARD-001", {
      userId: userId.toString(),
      role: "user",
    } as any);

    expect(result.valid).toBe(true);
    expect(result.message).toContain("hợp lệ");
  });

  it("vé có timeSlotId, check-in 35 phút trước slot start → valid: false, message 'Chưa tới giờ'", async () => {
    const adminId = new Types.ObjectId().toString();

    // Slot starts 35 min from now → outside 30-min grace window
    const futureSlotId = new Types.ObjectId();
    const futureSlot = {
      _id: futureSlotId,
      label: "Ca Tối",
      startTime: new Date(Date.now() + 35 * 60 * 1000),
      endTime: new Date(Date.now() + 3 * HOUR_MS),
    };

    stubTicketFindOne(
      makeTicketDoc({
        timeSlotId: futureSlotId,
        eventId: makeEventDoc([futureSlot]),
      })
    );

    const result = await ticketService.validateTicket("TK-GUARD-001", {
      userId: adminId,
      role: "admin",
    } as any);

    expect(result.valid).toBe(false);
    expect(result.message).toContain("Chưa tới giờ check-in");
  });

  it("vé có timeSlotId trỏ tới slot đã bị xóa khỏi event (orphan) → valid: false, message 'không còn tồn tại'", async () => {
    const adminId = new Types.ObjectId().toString();
    const deletedSlotId = new Types.ObjectId();

    stubTicketFindOne(
      makeTicketDoc({
        timeSlotId: deletedSlotId,
        eventId: makeEventDoc([]), // timeSlots là mảng rỗng
      })
    );

    const result = await ticketService.validateTicket("TK-GUARD-001", {
      userId: adminId,
      role: "admin",
    } as any);

    expect(result.valid).toBe(false);
    expect(result.message).toContain("không còn tồn tại");
  });

  it("vé không có timeSlotId, sự kiện đang diễn ra → valid: true", async () => {
    const userId = new Types.ObjectId();

    stubTicketFindOne(
      makeTicketDoc({
        userId,
        timeSlotId: undefined,
        eventId: makeEventDoc([]),
      })
    );

    const result = await ticketService.validateTicket("TK-GUARD-001", {
      userId: userId.toString(),
      role: "user",
    } as any);

    expect(result.valid).toBe(true);
    expect(result.message).toContain("hợp lệ");
  });

  it("user thường cố validate vé của người khác → ForbiddenException", async () => {
    const ticketOwner = new Types.ObjectId();
    const otherUser = new Types.ObjectId().toString();

    stubTicketFindOne(makeTicketDoc({ userId: ticketOwner }));

    await expect(
      ticketService.validateTicket("TK-GUARD-001", {
        userId: otherUser,
        role: "user",
      } as any)
    ).rejects.toThrow(ForbiddenException);
  });

  it("vé đã used → valid: false, message 'đã được sử dụng'", async () => {
    const adminId = new Types.ObjectId().toString();
    const checkedAt = new Date();

    stubTicketFindOne(
      makeTicketDoc({ status: "used", checkedInAt: checkedAt })
    );

    const result = await ticketService.validateTicket("TK-GUARD-001", {
      userId: adminId,
      role: "admin",
    } as any);

    expect(result.valid).toBe(false);
    expect(result.message).toContain("đã được sử dụng");
    expect((result as any).usedAt).toEqual(checkedAt);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. SLOT CAPACITY BOUNDARY — BookingService
// ═══════════════════════════════════════════════════════════════════════════════
describe("Edge Case — Slot Capacity Boundary (BookingService.createBooking)", () => {
  let bookingService: BookingService;
  let eventModel: any;
  let zoneModel: any;
  let redisClient: any;

  const slotId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();
  const CAPACITY = 5;

  const makeSession = () => ({
    withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
    endSession: jest.fn(),
  });

  const makeEventWithSlot = (capacity?: number) => ({
    _id: new Types.ObjectId(),
    isDeleted: false,
    status: "active",
    endDate: new Date(Date.now() + 24 * HOUR_MS),
    timeSlots: [
      {
        _id: slotId,
        label: "Ca Test",
        startTime: new Date(Date.now() - HOUR_MS),
        endTime: new Date(Date.now() + HOUR_MS),
        ...(capacity !== undefined ? { capacity } : {}),
      },
    ],
  });

  const makeDto = (qty = 1) => ({
    eventId: new Types.ObjectId().toString(),
    zoneId: zoneId.toString(),
    quantity: qty,
    timeSlotId: slotId.toString(),
    customerEmail: "boundary@test.com",
  });

  const buildModule = async (session: ReturnType<typeof makeSession>) => {
    const bookingModelMock: any = Object.assign(
      jest.fn().mockImplementation((data: any) => ({
        ...data,
        _id: new Types.ObjectId(),
        save: jest.fn().mockResolvedValue(undefined),
      })),
      {
        db: { startSession: jest.fn().mockResolvedValue(session) },
        findOne: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue(null),
        }),
        countDocuments: jest.fn().mockResolvedValue(0),
        find: jest.fn(),
        aggregate: jest
          .fn()
          .mockReturnValue({ session: jest.fn().mockResolvedValue([]) }),
        findOneAndUpdate: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      }
    );

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

    eventModel = { findById: jest.fn() };
    zoneModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingService,
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
        { provide: getModelToken(Booking.name), useValue: bookingModelMock },
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
        {
          provide: ZoneGateway,
          useValue: { emitZoneTicketUpdate: jest.fn() },
        },
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
          provide: EventOwnershipService,
          useValue: {
            assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
            getManagedEventIds: jest.fn().mockResolvedValue([]),
          },
        },
        {
          provide: NotificationService,
          useValue: {
            notifyBookingCreated: jest.fn().mockResolvedValue(undefined),
            notifyBookingCancelled: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: PromotionService,
          useValue: {
            applyPromotionToBooking: jest.fn(),
            releaseUsageForBooking: jest.fn(),
          },
        },
      ],
    }).compile();

    return module.get(BookingService);
  };

  it("slot đã đầy (INCRBY > capacity) → 400 'đã hết chỗ', DECRBY được gọi để rollback", async () => {
    const session = makeSession();
    bookingService = await buildModule(session);

    // Counter exceeds capacity after increment
    redisClient.incrBy.mockResolvedValue(CAPACITY + 1);

    const eventDoc = makeEventWithSlot(CAPACITY);
    eventModel.findById.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(eventDoc),
      }),
      session: jest.fn().mockResolvedValue({ ...eventDoc }),
    }));

    let caughtError: BadRequestException | undefined;
    try {
      await bookingService.createBooking(
        new Types.ObjectId().toString(),
        makeDto() as any
      );
    } catch (e) {
      caughtError = e as BadRequestException;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect(caughtError!.message).toContain("đã hết chỗ");
    expect(caughtError!.message).toContain(String(CAPACITY));
    expect(redisClient.incrBy).toHaveBeenCalledWith(
      `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
      1
    );
    expect(redisClient.decrBy).toHaveBeenCalledWith(
      `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
      1
    );
    // withTransaction was never called — rejected before DB operations
    expect(session.withTransaction).not.toHaveBeenCalled();
  });

  it("slot còn đúng 1 chỗ (INCRBY = capacity) → booking thành công, DECRBY không gọi", async () => {
    const session = makeSession();
    bookingService = await buildModule(session);

    // newCount === capacity → allowed (5 > 5 is false)
    redisClient.incrBy.mockResolvedValue(CAPACITY);

    const eventDoc = makeEventWithSlot(CAPACITY);
    const zoneDoc = {
      _id: zoneId,
      price: 100_000,
      hasSeating: false,
      capacity: 100,
      soldCount: 0,
      saleStartDate: null,
      saleEndDate: null,
    };

    eventModel.findById.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(eventDoc),
      }),
      session: jest.fn().mockResolvedValue({ ...eventDoc }),
    }));

    zoneModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(zoneDoc),
    });

    zoneModel.findOneAndUpdate.mockResolvedValue({ _id: zoneId });

    // For emitZoneTicketUpdate inside the service
    zoneModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: zoneId,
          eventId: new Types.ObjectId(),
          capacity: 100,
          soldCount: 1,
          confirmedSoldCount: 0,
        }),
      }),
    });

    const result = await bookingService.createBooking(
      new Types.ObjectId().toString(),
      makeDto() as any
    );

    expect(result?.success).toBe(true);
    expect(redisClient.incrBy).toHaveBeenCalledWith(
      `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
      1
    );
    expect(redisClient.decrBy).not.toHaveBeenCalled();
  });

  it("slot vô hạn (không có capacity) → INCRBY không được gọi, booking thành công", async () => {
    const session = makeSession();
    bookingService = await buildModule(session);

    const eventDoc = makeEventWithSlot(); // no capacity field
    const zoneDoc = {
      _id: zoneId,
      price: 0,
      hasSeating: false,
      capacity: 999,
      soldCount: 0,
      saleStartDate: null,
      saleEndDate: null,
    };

    eventModel.findById.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(eventDoc),
      }),
      session: jest.fn().mockResolvedValue({ ...eventDoc }),
    }));

    zoneModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(zoneDoc),
    });

    zoneModel.findOneAndUpdate.mockResolvedValue({ _id: zoneId });

    zoneModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: zoneId,
          eventId: new Types.ObjectId(),
          capacity: 999,
          soldCount: 1,
          confirmedSoldCount: 0,
        }),
      }),
    });

    const result = await bookingService.createBooking(
      new Types.ObjectId().toString(),
      makeDto() as any
    );

    expect(result?.success).toBe(true);
    expect(redisClient.incrBy).not.toHaveBeenCalled();
    expect(redisClient.decrBy).not.toHaveBeenCalled();
  });

  it("DB fail sau INCRBY (zoneUpdate null = Không đủ vé) → DECRBY rollback đúng quantity", async () => {
    const QTY = 3;
    const session = makeSession();
    bookingService = await buildModule(session);

    // INCRBY succeeds (counter = 3, under capacity of 5)
    redisClient.incrBy.mockResolvedValue(3);

    const eventDoc = makeEventWithSlot(CAPACITY);
    const zoneDoc = {
      _id: zoneId,
      price: 50_000,
      hasSeating: false,
      capacity: 100,
      soldCount: 0,
      saleStartDate: null,
      saleEndDate: null,
    };

    eventModel.findById.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(eventDoc),
      }),
      session: jest.fn().mockResolvedValue({ ...eventDoc }),
    }));

    zoneModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(zoneDoc),
    });

    // findOneAndUpdate returns null → throws "Không đủ vé" inside withTransaction
    zoneModel.findOneAndUpdate.mockResolvedValue(null);

    let caughtError: BadRequestException | undefined;
    try {
      await bookingService.createBooking(
        new Types.ObjectId().toString(),
        makeDto(QTY) as any
      );
    } catch (e) {
      caughtError = e as BadRequestException;
    }

    expect(caughtError).toBeInstanceOf(BadRequestException);
    expect(caughtError!.message).toContain("Không đủ vé");
    // Rollback must use the exact quantity that was reserved
    expect(redisClient.decrBy).toHaveBeenCalledWith(
      `${SLOT_SOLD_KEY_PREFIX}${slotId}`,
      QTY
    );
  });
});
