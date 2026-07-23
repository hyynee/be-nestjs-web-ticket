import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
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

jest.mock("./booking.constants", () => ({
  ...jest.requireActual("./booking.constants"),
  ZONE_INFO_STAMPEDE_MAX_POLLS: 1,
  ZONE_INFO_STAMPEDE_POLL_DELAY_MS: 1,
}));
import {
  Booking,
  BookingStatus,
  PaymentStatus,
  SeatLock,
} from "@src/schemas/booking.schema";
import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Payment } from "@src/schemas/payment.schema";
import { SeatState } from "@src/schemas/seat-state.schema";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { ZoneService } from "@src/zone/zone.service";
import { RedisService } from "@src/redis/redis.service";
import { PaymentService } from "@src/payment/payment.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { AuditService } from "@src/audit/audit.service";
import { UploadService } from "@src/upload/upload.service";
import { NotificationService } from "@src/notification/notification.service";
import { PromotionService } from "@src/promotion/promotion.service";
import { MAX_TICKETS_PER_USER_PER_EVENT } from "./booking.constants";

describe("BookingService", () => {
  let service: BookingWorkflowService;

  const userId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();
  const zoneId = new Types.ObjectId().toString();
  const areaId = new Types.ObjectId().toString();

  const createSessionMock = () => ({
    withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
    endSession: jest.fn(),
  });

  let bookingModel: any;
  let eventModel: any;
  let zoneModel: any;
  let areaModel: any;
  let ticketModel: any;
  let paymentModel: any;
  let seatLockModel: any;
  let seatStateModel: any;
  let zoneGateway: { emitZoneTicketUpdate: jest.Mock };
  let paymentService: { issueAdminRefund: jest.Mock };
  let promotionService: {
    applyPromotionToBooking: jest.Mock;
    releaseUsageForBooking: jest.Mock;
  };
  let redisService: {
    client: {
      scan: jest.Mock;
      del: jest.Mock;
      set: jest.Mock;
      get: jest.Mock;
      eval: jest.Mock;
      sMembers: jest.Mock;
      sAdd: jest.Mock;
      expire: jest.Mock;
    };
  };
  let auditService: { record: jest.Mock };
  let metricsService: {
    bookingsTotal: { inc: jest.Mock };
    paymentsTotal: { inc: jest.Mock };
    refundFailuresTotal: { inc: jest.Mock };
    checkinsTotal: { inc: jest.Mock };
    bookingConflictTotal: { inc: jest.Mock };
    redisOperationFailureTotal: { inc: jest.Mock };
  };
  let uploadService: {
    uploadImage: jest.Mock;
    deleteQRCode: jest.Mock;
  };
  let eventOwnershipService: {
    assertCanManageEvent: jest.Mock;
    getManagedEventIds: jest.Mock;
  };

  const mockCreateContext = (zone: any, event?: any) => {
    eventModel.findById.mockReturnValue({
      session: jest.fn().mockResolvedValue(
        event ?? {
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "active",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }
      ),
    });

    zoneModel.findOne.mockReturnValue({
      session: jest.fn().mockResolvedValue(zone),
    });
  };

  const makeSessionForCreate = () => {
    const session = createSessionMock();
    bookingModel.db.startSession.mockResolvedValue(session);
    return session;
  };

  const mockEmitZoneSnapshot = () => {
    zoneModel.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          capacity: 100,
          soldCount: 20,
          confirmedSoldCount: 7,
        }),
      }),
    });
  };

  beforeEach(async () => {
    const session = createSessionMock();

    bookingModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      _id: new Types.ObjectId(),
      save: jest.fn().mockResolvedValue(undefined),
    }));
    bookingModel.db = {
      startSession: jest.fn().mockResolvedValue(session),
    };
    bookingModel.findOne = jest.fn();
    bookingModel.findOneAndUpdate = jest.fn();
    bookingModel.find = jest.fn();
    // Default: user has 0 existing ticket quantity → per-user limit check passes
    bookingModel.aggregate = jest
      .fn()
      .mockReturnValue({ session: jest.fn().mockResolvedValue([]) });
    bookingModel.countDocuments = jest.fn().mockResolvedValue(0);
    bookingModel.updateMany = jest.fn();
    bookingModel.deleteMany = jest.fn();

    eventModel = {
      findById: jest.fn(),
    };

    zoneModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      findById: jest.fn(),
      findByIdAndUpdate: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({}),
      bulkWrite: jest.fn(),
    };

    areaModel = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const chainableQuery = {
      select: jest.fn().mockReturnThis(),
      session: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    };
    ticketModel = {
      find: jest.fn().mockReturnValue(chainableQuery),
      findById: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    };

    paymentModel = {
      updateMany: jest.fn(),
    };

    seatLockModel = {
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      deleteMany: jest.fn(),
      create: jest.fn(),
      find: jest.fn(),
      insertMany: jest.fn().mockResolvedValue([]),
    };

    seatStateModel = {
      find: jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      }),
    };

    zoneGateway = {
      emitZoneTicketUpdate: jest.fn(),
    };

    paymentService = {
      issueAdminRefund: jest.fn().mockResolvedValue(undefined),
    };

    redisService = {
      client: {
        scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
        del: jest.fn().mockResolvedValue(0),
        set: jest.fn().mockResolvedValue("OK"),
        get: jest.fn().mockResolvedValue(null),
        eval: jest.fn().mockResolvedValue(null),
        sMembers: jest.fn().mockResolvedValue([]),
        sAdd: jest.fn().mockResolvedValue(1),
        expire: jest.fn().mockResolvedValue(1),
      },
    };
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    metricsService = {
      bookingsTotal: { inc: jest.fn() },
      paymentsTotal: { inc: jest.fn() },
      refundFailuresTotal: { inc: jest.fn() },
      checkinsTotal: { inc: jest.fn() },
      bookingConflictTotal: { inc: jest.fn() },
      redisOperationFailureTotal: { inc: jest.fn() },
    };
    uploadService = {
      uploadImage: jest.fn(),
      deleteQRCode: jest.fn().mockResolvedValue(undefined),
    };
    eventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };
    promotionService = {
      applyPromotionToBooking: jest.fn(),
      releaseUsageForBooking: jest.fn().mockResolvedValue(undefined),
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
        { provide: getModelToken(Area.name), useValue: areaModel },
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: getModelToken(SeatLock.name), useValue: seatLockModel },
        { provide: getModelToken(SeatState.name), useValue: seatStateModel },
        { provide: ZoneGateway, useValue: zoneGateway },
        {
          provide: ZoneService,
          useValue: { invalidateZoneAvailabilityCache: jest.fn() },
        },
        { provide: RedisService, useValue: redisService },
        { provide: PaymentService, useValue: paymentService },
        {
          provide: MetricsService,
          useValue: metricsService,
        },
        {
          provide: AuditService,
          useValue: auditService,
        },
        {
          provide: UploadService,
          useValue: uploadService,
        },
        {
          provide: require("@src/event/event-ownership.service")
            .EventOwnershipService,
          useValue: eventOwnershipService,
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
          useValue: promotionService,
        },
      ],
    }).compile();

    service = module.get<BookingWorkflowService>(BookingWorkflowService);
  });

  describe("createBooking", () => {
    const baseDto = {
      eventId,
      zoneId,
      quantity: 2,
      customerEmail: "demo@example.com",
      customerName: "Demo",
    };

    it("throws BadRequestException when event has non-bookable non-cancelled status", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "inactive",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(new BadRequestException("Sự kiện chưa mở bán"));
    });

    it("throws BadRequestException when event has past endDate", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "active",
          endDate: new Date(Date.now() - 24 * 60 * 60 * 1000),
        }),
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(new BadRequestException("Sự kiện đã kết thúc"));
    });

    it("throws NotFoundException when event is missing", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when event is cancelled", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "cancelled",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      });

      await expect(
        service.createBooking(userId, {
          eventId,
          zoneId,
          quantity: 1,
          customerEmail: "test@example.com",
          customerName: "Test",
        } as any)
      ).rejects.toThrow(new BadRequestException("Sự kiện đã bị hủy"));
    });

    it("rejects seated zone without areaId", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(
        new BadRequestException("Vui lòng chọn hàng ghế (area)")
      );
    });

    it("rejects duplicated seats for seated zone", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });

      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          quantity: 2,
          areaId,
          seats: ["A1", "A1"],
        } as any)
      ).rejects.toThrow(
        new BadRequestException("Danh sách ghế bị trùng, vui lòng chọn lại")
      );
    });

    it("rejects areaId for non-seating zone", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 80,
        hasSeating: false,
        isDeleted: false,
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          areaId,
        } as any)
      ).rejects.toThrow(
        new BadRequestException(
          "Không thể chọn hàng ghế cho khu vực không có chỗ ngồi"
        )
      );
    });

    it("rejects when zone capacity is insufficient", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 80,
        hasSeating: false,
        isDeleted: false,
      });

      zoneModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(new BadRequestException("Không đủ vé"));
    });

    it("creates booking successfully for seated zone", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });

      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });

      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue(null),
        }),
      });

      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });
      mockEmitZoneSnapshot();

      const result = await service.createBooking(userId, {
        ...baseDto,
        quantity: 2,
        areaId,
        seats: ["A1", "A2"],
      } as any);

      expect(result.success).toBe(true);
      expect(result.message).toBe("Tạo booking thành công");

      const bookingPayload = bookingModel.mock.calls[0][0];
      expect(bookingPayload.pricePerTicket).toBe(120);
      expect(bookingPayload.totalPrice).toBe(240);
      expect(bookingPayload.status).toBe(BookingStatus.PENDING);
      expect(bookingPayload.paymentStatus).toBe(PaymentStatus.UNPAID);
      expect(bookingPayload.seats).toEqual(["A1", "A2"]);
      expect(bookingPayload.areaId).toBeDefined();

      expect(zoneGateway.emitZoneTicketUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          availableTickets: 80,
          soldCount: 20,
          confirmedSoldCount: 7,
        })
      );
    });

    it("applies promotion inside booking transaction and returns discounted totals", async () => {
      const event = {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        status: "active",
        endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        title: "Concert A",
        startDate: new Date(Date.now() + 60 * 60 * 1000),
        location: "HCM",
      };
      mockCreateContext(
        {
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          price: 100_000,
          hasSeating: false,
          isDeleted: false,
        },
        event
      );
      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });
      mockEmitZoneSnapshot();
      const promotionId = new Types.ObjectId().toString();
      promotionService.applyPromotionToBooking.mockResolvedValue({
        valid: true,
        promotionId,
        code: "SAVE50",
        type: "fixed",
        value: 50_000,
        originalAmount: 200_000,
        discountAmount: 50_000,
        finalAmount: 150_000,
        usageId: new Types.ObjectId().toString(),
      });

      const result = await service.createBooking(userId, {
        ...baseDto,
        quantity: 2,
        promotionCode: "SAVE50",
      } as any);

      expect(promotionService.applyPromotionToBooking).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "SAVE50",
          userId,
          eventId,
          zoneId,
          orderAmount: 200_000,
        }),
        expect.any(Object)
      );
      expect(result.data.originalTotalPrice).toBe(200_000);
      expect(result.data.discountAmount).toBe(50_000);
      expect(result.data.promotionCode).toBe("SAVE50");
      expect(result.data.promotionId).toBe(promotionId);
      expect(result.data.totalPrice).toBe(150_000);
    });

    it("populates an immutable snapshot of event/zone/area facts at booking time (seated zone)", async () => {
      const customEvent = {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        status: "active",
        title: "Concert A",
        location: "HCM",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
      };
      mockCreateContext(
        {
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          name: "VIP",
          price: 120,
          hasSeating: true,
          isDeleted: false,
        },
        customEvent
      );

      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            name: "Row A",
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });

      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue(null),
        }),
      });

      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });
      mockEmitZoneSnapshot();

      await service.createBooking(userId, {
        ...baseDto,
        quantity: 2,
        areaId,
        seats: ["A1", "A2"],
      } as any);

      const bookingPayload = bookingModel.mock.calls[0][0];
      expect(bookingPayload.snapshot).toEqual({
        eventTitle: "Concert A",
        eventStartDate: customEvent.startDate,
        eventEndDate: customEvent.endDate,
        location: "HCM",
        zoneName: "VIP",
        areaName: "Row A",
        seats: ["A1", "A2"],
        pricePerTicket: 120,
        currency: "VND",
      });
    });

    it("populates a snapshot without seats/areaName for a non-seating (general admission) zone", async () => {
      const customEvent = {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        status: "active",
        title: "Festival B",
        location: "Da Nang",
        startDate: new Date("2030-03-01"),
        endDate: new Date("2030-03-02"),
      };
      mockCreateContext(
        {
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          name: "General",
          price: 80,
          hasSeating: false,
          isDeleted: false,
        },
        customEvent
      );

      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });
      mockEmitZoneSnapshot();

      await service.createBooking(userId, baseDto as any);

      const bookingPayload = bookingModel.mock.calls[0][0];
      expect(bookingPayload.snapshot).toEqual({
        eventTitle: "Festival B",
        eventStartDate: customEvent.startDate,
        eventEndDate: customEvent.endDate,
        location: "Da Nang",
        zoneName: "General",
        areaName: undefined,
        seats: undefined,
        pricePerTicket: 80,
        currency: "VND",
      });
    });

    it("throws NotFoundException when zone does not exist", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "active",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      });
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when sale has not started", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "active",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      });
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          price: 100,
          hasSeating: false,
          isDeleted: false,
          saleStartDate: new Date(Date.now() + 60 * 60 * 1000),
        }),
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(new BadRequestException("Chưa tới thời gian bán vé"));
    });

    it("throws BadRequestException when sale has ended", async () => {
      eventModel.findById.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          status: "active",
          endDate: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }),
      });
      zoneModel.findOne.mockReturnValue({
        session: jest.fn().mockResolvedValue({
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          price: 100,
          hasSeating: false,
          isDeleted: false,
          saleEndDate: new Date(Date.now() - 60 * 60 * 1000),
        }),
      });

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(new BadRequestException("Đã hết thời gian bán vé"));
    });

    it("throws NotFoundException when area does not exist for seated zone", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });
      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          areaId,
          seats: ["A1", "A2"],
        } as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("rejects when seats count does not match quantity", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });
      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          quantity: 2,
          areaId,
          seats: ["A1"],
        } as any)
      ).rejects.toThrow(
        new BadRequestException("Số lượng ghế phải bằng số lượng vé")
      );
    });

    it("rejects when seats contain invalid seat names", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });
      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          quantity: 2,
          areaId,
          seats: ["B1", "B2"],
        } as any)
      ).rejects.toThrow(
        new BadRequestException("Các ghế không hợp lệ: B1, B2")
      );
    });

    it("throws BadRequestException when seated zone has empty seats array", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });
      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });

      await expect(
        service.createBooking(userId, { ...baseDto, areaId, seats: [] } as any)
      ).rejects.toThrow(
        new BadRequestException("Khu vực này yêu cầu chọn ghế cụ thể")
      );
    });

    it("rejects when seats are blocked or disabled via SeatState overrides", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });
      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });
      seatStateModel.find.mockReturnValue({
        session: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ seat: "A1" }]),
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          quantity: 2,
          areaId,
          seats: ["A1", "A2"],
        } as any)
      ).rejects.toThrow(new BadRequestException("Ghế không khả dụng: A1"));
    });

    it("rejects when seat conflict exists (seats already booked)", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 120,
        hasSeating: true,
        isDeleted: false,
      });
      areaModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(areaId),
            seats: ["A1", "A2", "A3"],
          }),
        }),
      });
      bookingModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          select: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
        }),
      });

      await expect(
        service.createBooking(userId, {
          ...baseDto,
          quantity: 2,
          areaId,
          seats: ["A1", "A2"],
        } as any)
      ).rejects.toThrow(
        new BadRequestException("Một số ghế đã được đặt, vui lòng chọn lại")
      );
    });

    it("rejects when non-seating zone receives seats", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 80,
        hasSeating: false,
        isDeleted: false,
      });

      await expect(
        service.createBooking(userId, { ...baseDto, seats: ["A1"] } as any)
      ).rejects.toThrow(
        new BadRequestException(
          "Không thể chọn ghế cho khu vực không có chỗ ngồi"
        )
      );
    });

    it("throws BadRequestException when concurrent user booking lock is held", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.set.mockResolvedValue(null);

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(
        new BadRequestException(
          "Đang có yêu cầu đặt vé khác đang xử lý. Vui lòng thử lại sau giây lát."
        )
      );
    });

    it("HIGH fix: Redis SET throwing (Redis outage) on the user-event lock fails closed with ServiceUnavailableException, never a raw 500, and never reaches the Mongo transaction", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.set.mockRejectedValue(
        new Error("connect ECONNREFUSED 127.0.0.1:6379")
      );

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(ServiceUnavailableException);

      expect(bookingModel.db.startSession).not.toHaveBeenCalled();
      expect(
        metricsService.redisOperationFailureTotal.inc
      ).toHaveBeenCalledWith({ operation: "user_lock_set" });
      expect(metricsService.bookingsTotal.inc).toHaveBeenCalledWith({
        status: "error",
      });
    });

    it("re-throws E11000 duplicate key error as BadRequestException", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 80,
        hasSeating: false,
        isDeleted: false,
      });
      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });
      mockEmitZoneSnapshot();

      const session = makeSessionForCreate();
      const dupError = Object.assign(new Error("E11000 duplicate"), {
        code: 11000,
      });
      session.withTransaction.mockRejectedValue(dupError);

      await expect(
        service.createBooking(userId, baseDto as any)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getMyBookings", () => {
    it("returns cached result when Redis returns data", async () => {
      const cachedData = {
        success: true,
        items: [{ _id: "booking1" }],
        meta: {
          currentPage: 1,
          itemsPerPage: 10,
          totalItems: 1,
          totalPages: 1,
          hasPreviousPage: false,
          hasNextPage: false,
        },
      };
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await service.getMyBookings(userId, "confirmed", 1, 10);

      expect(result).toEqual(cachedData);
      expect(bookingModel.find).not.toHaveBeenCalled();
    });

    it("queries DB when cache misses and returns paginated result with status filter", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);

      const bookings = [{ _id: new Types.ObjectId(), status: "confirmed" }];
      bookingModel.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(bookings),
      });
      bookingModel.countDocuments.mockResolvedValue(1);

      const result = await service.getMyBookings(userId, "confirmed", 2, 5);

      expect(result.success).toBe(true);
      expect(result.items).toEqual([
        expect.objectContaining({
          id: bookings[0]._id.toString(),
          status: "confirmed",
        }),
      ]);
      expect(result.meta.currentPage).toBe(2);
      expect(result.meta.hasPreviousPage).toBe(true);
    });

    it("falls through to DB when Redis GET fails", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockRejectedValue(new Error("Redis down"));

      const bookings = [{ _id: new Types.ObjectId() }];
      bookingModel.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(bookings),
      });
      bookingModel.countDocuments.mockResolvedValue(1);

      const result = await service.getMyBookings(userId);

      expect(result.success).toBe(true);
      expect(result.items).toHaveLength(1);
    });

    it("overlays the booking's snapshot onto the populated eventId/zoneId/areaId, so a renamed event/zone doesn't rewrite booking history", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);

      const bookings = [
        {
          _id: new Types.ObjectId(),
          status: "confirmed",
          eventId: { title: "Live title (renamed since booking)" },
          zoneId: { name: "Live zone (renamed since booking)" },
          areaId: { name: "Live area" },
          snapshot: {
            eventTitle: "Original title at booking time",
            location: "Original location",
            eventStartDate: new Date("2029-01-01"),
            eventEndDate: new Date("2029-01-02"),
            zoneName: "Original zone name",
            areaName: "Original area name",
          },
        },
      ];
      bookingModel.find.mockReturnValue({
        populate: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(bookings),
      });
      bookingModel.countDocuments.mockResolvedValue(1);

      const result = await service.getMyBookings(userId);

      expect(result.items[0].event?.title).toBe(
        "Original title at booking time"
      );
      expect(result.items[0].zone?.name).toBe("Original zone name");
      expect(result.items[0].area?.name).toBe("Original area name");
    });
  });

  describe("getBookingByCode", () => {
    const makePopulateChain = (resolvedValue: any) => {
      const q = Object.assign(Promise.resolve(resolvedValue), {
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(resolvedValue),
        exec: jest.fn().mockResolvedValue(resolvedValue),
      });
      return q;
    };

    it("returns booking when found with userId filter", async () => {
      const bookingDoc = { _id: new Types.ObjectId(), bookingCode: "BK001" };
      bookingModel.findOne.mockReturnValue(makePopulateChain(bookingDoc));

      const result = await service.getBookingByCode(userId, "BK001");

      expect(result.success).toBe(true);
      expect(result.data).toEqual(
        expect.objectContaining({
          id: bookingDoc._id.toString(),
          bookingCode: bookingDoc.bookingCode,
        })
      );
    });

    it("throws NotFoundException when booking not found", async () => {
      bookingModel.findOne.mockReturnValue(makePopulateChain(null));

      await expect(service.getBookingByCode(userId, "INVALID")).rejects.toThrow(
        NotFoundException
      );
    });

    it("queries without userId filter when userId is empty", async () => {
      const bookingDoc = { _id: new Types.ObjectId(), bookingCode: "BK002" };
      bookingModel.findOne.mockReturnValue(makePopulateChain(bookingDoc));

      const result = await service.getBookingByCode("", "BK002");

      expect(result.success).toBe(true);
    });

    it("overlays the booking's snapshot onto the populated eventId/zoneId/areaId", async () => {
      const bookingDoc = {
        _id: new Types.ObjectId(),
        bookingCode: "BK001",
        eventId: { title: "Live title (renamed since booking)" },
        zoneId: { name: "Live zone (renamed since booking)" },
        snapshot: {
          eventTitle: "Original title at booking time",
          location: "Original location",
          eventStartDate: new Date("2029-01-01"),
          eventEndDate: new Date("2029-01-02"),
          zoneName: "Original zone name",
        },
      };
      bookingModel.findOne.mockReturnValue(makePopulateChain(bookingDoc));

      const result = await service.getBookingByCode(userId, "BK001");

      expect(result.data.event?.title).toBe("Original title at booking time");
      expect(result.data.zone?.name).toBe("Original zone name");
    });
  });

  describe("getZoneBookingInfo", () => {
    it("returns areas and deduplicated booked seats when zone has seating", async () => {
      eventModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        title: "Concert",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      });

      zoneModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        name: "VIP",
        price: 500,
        hasSeating: true,
        capacity: 100,
        soldCount: 10,
      });

      areaModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: new Types.ObjectId(areaId),
              name: "ROW A",
              rowLabel: "A",
              seatCount: 10,
            },
          ]),
        }),
      });

      // Bug 8 fix: getZoneBookingInfo dùng aggregate thay vì find
      bookingModel.aggregate.mockResolvedValue([
        {
          _id: new Types.ObjectId(areaId),
          seats: ["A1", "A2", "A3"],
        },
      ]);

      const result = await service.getZoneBookingInfo(eventId, zoneId);

      expect(result.zone.availableTickets).toBe(90);
      expect(result.areas).toHaveLength(1);
      expect(result.bookedSeatsByArea?.[areaId]).toEqual(
        expect.arrayContaining(["A1", "A2", "A3"])
      );
    });

    it("throws NotFoundException when event is deleted", async () => {
      eventModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
        isDeleted: true,
      });

      await expect(service.getZoneBookingInfo(eventId, zoneId)).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws NotFoundException when zone does not exist", async () => {
      eventModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        title: "Concert",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      });
      zoneModel.findOne.mockResolvedValue(null);

      await expect(service.getZoneBookingInfo(eventId, zoneId)).rejects.toThrow(
        NotFoundException
      );
    });

    it("filters out null areaId from bookedSeatsByArea aggregate", async () => {
      eventModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        title: "Concert",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      });
      zoneModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        name: "VIP",
        price: 500,
        hasSeating: true,
        capacity: 100,
        soldCount: 10,
      });
      areaModel.find.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        }),
      });
      bookingModel.aggregate.mockResolvedValue([
        { _id: null, seats: ["A1", "A2"] },
        { _id: new Types.ObjectId(areaId), seats: ["B1"] },
      ]);

      const result = await service.getZoneBookingInfo(eventId, zoneId);

      expect(result.bookedSeatsByArea).not.toHaveProperty("null");
      expect(result.bookedSeatsByArea?.[areaId]).toEqual(["B1"]);
    });

    it("falls through stampede lock polling when lock holder crashes and computes directly", async () => {
      eventModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        title: "Concert",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      });

      zoneModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        name: "VIP",
        price: 500,
        hasSeating: false,
        capacity: 100,
        soldCount: 10,
      });

      const mockRedisClient = redisService.client;
      mockRedisClient.set.mockRejectedValue(new Error("Redis down"));
      mockRedisClient.get.mockResolvedValue(null);

      const result = await service.getZoneBookingInfo(eventId, zoneId);

      expect(result.zone.availableTickets).toBe(90);
    });

    it("returns null area data when zone has no seating", async () => {
      eventModel.findById.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        title: "Festival",
        startDate: new Date("2030-02-01"),
        endDate: new Date("2030-02-02"),
        location: "HN",
      });

      zoneModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        name: "FREE",
        price: 100,
        hasSeating: false,
        capacity: 500,
        soldCount: 123,
      });

      const result = await service.getZoneBookingInfo(eventId, zoneId);

      expect(result.areas).toBeNull();
      expect(result.bookedSeatsByArea).toBeNull();
      expect(result.zone.availableTickets).toBe(377);
    });
  });

  describe("cancelBooking", () => {
    it("throws BadRequestException when booking does not belong to user", async () => {
      const consoleSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      try {
        const session = createSessionMock();
        bookingModel.db.startSession.mockResolvedValue(session);

        // userId filter in findOneAndUpdate eliminates the wrong-owner booking atomically
        bookingModel.findOneAndUpdate.mockResolvedValue(null);

        await expect(
          service.cancelBooking(userId, { bookingCode: "BK001" })
        ).rejects.toThrow(BadRequestException);
      } finally {
        consoleSpy.mockRestore();
      }
    });

    it("cancels pending unpaid booking and decrements soldCount", async () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);

      const bookingDoc = {
        _id: new Types.ObjectId(),
        bookingCode: "BK001",
        userId: new Types.ObjectId(userId),
        status: BookingStatus.CANCELLED,
        paymentStatus: PaymentStatus.UNPAID,
        quantity: 3,
        zoneId: new Types.ObjectId(zoneId),
      };

      // new: true returns the already-updated document
      bookingModel.findOneAndUpdate.mockResolvedValue(bookingDoc);

      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      mockEmitZoneSnapshot();

      const result = await service.cancelBooking(userId, {
        bookingCode: "bk001",
      });

      expect(result).toEqual({ message: "Booking cancelled successfully" });
      expect(bookingModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          bookingCode: "bk001",
          status: BookingStatus.PENDING,
          paymentStatus: PaymentStatus.UNPAID,
          isDeleted: false,
        }),
        expect.objectContaining({
          $set: expect.objectContaining({ status: BookingStatus.CANCELLED }),
        }),
        expect.any(Object)
      );
      expect(ticketModel.updateMany).toHaveBeenCalled();
      expect(zoneModel.updateOne).toHaveBeenCalledWith(
        { _id: bookingDoc.zoneId },
        expect.any(Array),
        { session }
      );
      expect(zoneGateway.emitZoneTicketUpdate).toHaveBeenCalled();
    });

    describe("concurrent cancel vs Stripe confirm — only one winner", () => {
      it("Stripe confirms first: cancel's findOneAndUpdate returns null → BadRequestException, zone not touched", async () => {
        // Stripe's handleCheckoutSessionCompleted ran findOneAndUpdate({status:PENDING,paymentStatus:UNPAID})
        // and won. By the time cancelBooking runs, the booking is no longer PENDING+UNPAID.
        const consoleSpy = jest
          .spyOn(console, "error")
          .mockImplementation(() => undefined);
        try {
          const session = createSessionMock();
          bookingModel.db.startSession.mockResolvedValue(session);

          bookingModel.findOneAndUpdate.mockResolvedValue(null);

          await expect(
            service.cancelBooking(userId, { bookingCode: "BK-RACE" })
          ).rejects.toThrow(BadRequestException);

          // Critical: soldCount must NOT be decremented — Stripe already owns the booking
          expect(zoneModel.updateOne).not.toHaveBeenCalled();
          expect(ticketModel.updateMany).not.toHaveBeenCalled();
        } finally {
          consoleSpy.mockRestore();
        }
      });

      it("cancel wins first: findOneAndUpdate succeeds → booking cancelled, zone decremented; Stripe's subsequent findOneAndUpdate sees no PENDING match", async () => {
        // cancelBooking's findOneAndUpdate({status:PENDING,paymentStatus:UNPAID}) runs first.
        // Stripe's subsequent findOneAndUpdate on the same filter returns null — no double-processing.
        const session = createSessionMock();
        bookingModel.db.startSession.mockResolvedValue(session);

        const bookingDoc = {
          _id: new Types.ObjectId(),
          bookingCode: "BK-RACE",
          userId: new Types.ObjectId(userId),
          status: BookingStatus.CANCELLED,
          paymentStatus: PaymentStatus.UNPAID,
          quantity: 2,
          zoneId: new Types.ObjectId(zoneId),
        };

        bookingModel.findOneAndUpdate.mockResolvedValue(bookingDoc);
        ticketModel.updateMany.mockResolvedValue({});
        zoneModel.updateOne.mockResolvedValue({});
        mockEmitZoneSnapshot();

        const result = await service.cancelBooking(userId, {
          bookingCode: "BK-RACE",
        });

        expect(result).toEqual({ message: "Booking cancelled successfully" });
        // Exactly one atomic write — no partial state possible
        expect(bookingModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
        expect(zoneModel.updateOne).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("expirePendingBookings", () => {
    const zone1Id = new Types.ObjectId();
    const booking1Id = new Types.ObjectId();
    const booking2Id = new Types.ObjectId();

    const makeCandidate = (id: Types.ObjectId, qty: number) => ({
      _id: id,
      zoneId: zone1Id,
      quantity: qty,
    });

    const setupSession = () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);
      return session;
    };

    // Helper that builds the chained mock for bookingModel.find().session().limit().lean()
    const mockFindChain = (resolvedValue: unknown[]) => {
      bookingModel.find.mockReturnValue({
        session: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(resolvedValue),
          }),
        }),
      });
    };

    it("returns early when no pending expired bookings exist", async () => {
      setupSession();
      mockFindChain([]);

      const result = await service.expirePendingBookings();

      expect(result).toMatchObject({ expired: 0 });
      expect(bookingModel.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({ status: BookingStatus.PENDING }),
        expect.anything(),
        expect.anything()
      );
      expect(zoneModel.bulkWrite).not.toHaveBeenCalled();
    });

    it("expires all pending bookings when no concurrent confirmation occurs", async () => {
      setupSession();
      const candidates = [
        makeCandidate(booking1Id, 3),
        makeCandidate(booking2Id, 2),
      ];
      mockFindChain(candidates);

      // Both bookings transitioned to EXPIRED — updateMany modifiedCount=2
      bookingModel.updateMany.mockResolvedValueOnce({ modifiedCount: 2 });

      // Re-query returns both docs as actually expired (both quantity contribute)
      const expiredDocs = [
        { _id: booking1Id, zoneId: zone1Id, quantity: 3 },
        { _id: booking2Id, zoneId: zone1Id, quantity: 2 },
      ];
      bookingModel.find
        .mockReturnValueOnce({
          session: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockResolvedValue(candidates),
            }),
          }),
        })
        .mockReturnValueOnce({
          session: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue(expiredDocs),
          }),
        });

      zoneModel.bulkWrite.mockResolvedValue({});
      mockEmitZoneSnapshot();

      const result = await service.expirePendingBookings();

      expect(result).toMatchObject({ expired: 2 });
      expect(bookingModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ status: BookingStatus.PENDING }),
        { $set: { status: BookingStatus.EXPIRED } },
        expect.any(Object)
      );
      // soldCount decremented by 3+2 = 5
      expect(zoneModel.bulkWrite).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            updateOne: expect.objectContaining({
              filter: { _id: zone1Id },
              update: [
                {
                  $set: {
                    soldCount: { $max: [{ $subtract: ["$soldCount", 5] }, 0] },
                  },
                },
              ],
            }),
          }),
        ]),
        expect.any(Object)
      );
    });

    it("skips Stripe-confirmed booking and only decrements the truly expired quantity", async () => {
      // Core race condition test.
      // booking1 (qty 3): still PENDING → expires correctly.
      // booking2 (qty 2): confirmed by Stripe concurrently → not in re-query results.
      // Expected: soldCount decremented by 3 only, NOT 5.
      setupSession();
      const candidates = [
        makeCandidate(booking1Id, 3),
        makeCandidate(booking2Id, 2),
      ];
      mockFindChain(candidates);

      // updateMany modified only 1 (booking2 was already CONFIRMED)
      bookingModel.updateMany.mockResolvedValueOnce({ modifiedCount: 1 });

      // Re-query returns only booking1 (booking2 now CONFIRMED, not EXPIRED)
      bookingModel.find
        .mockReturnValueOnce({
          session: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockResolvedValue(candidates),
            }),
          }),
        })
        .mockReturnValueOnce({
          session: jest.fn().mockReturnValue({
            lean: jest
              .fn()
              .mockResolvedValue([
                { _id: booking1Id, zoneId: zone1Id, quantity: 3 },
              ]),
          }),
        });

      zoneModel.bulkWrite.mockResolvedValue({});
      mockEmitZoneSnapshot();

      const result = await service.expirePendingBookings();

      expect(result).toMatchObject({ expired: 1 });

      // bulkWrite must use only booking1's quantity (3), not 3+2=5
      expect(zoneModel.bulkWrite).toHaveBeenCalledWith(
        [
          {
            updateOne: {
              filter: { _id: zone1Id },
              update: [
                {
                  $set: {
                    soldCount: { $max: [{ $subtract: ["$soldCount", 3] }, 0] },
                  },
                },
              ],
            },
          },
        ],
        expect.any(Object)
      );
    });

    it("re-throws error when transaction fails", async () => {
      const session = setupSession();
      session.withTransaction.mockRejectedValue(
        new Error("Transaction failed")
      );

      await expect(service.expirePendingBookings()).rejects.toThrow(
        "Transaction failed"
      );
    });

    it("does not call bulkWrite when all candidates were confirmed concurrently", async () => {
      setupSession();
      const candidates = [
        makeCandidate(booking1Id, 3),
        makeCandidate(booking2Id, 2),
      ];
      mockFindChain(candidates);

      // updateMany modified 0 (all confirmed by Stripe)
      bookingModel.updateMany.mockResolvedValueOnce({ modifiedCount: 0 });

      const result = await service.expirePendingBookings();

      expect(result).toMatchObject({ expired: 0 });
      expect(zoneModel.bulkWrite).not.toHaveBeenCalled();
    });
  });

  describe("getAllBookings", () => {
    const baseQuery = { page: 1, limit: 20 };
    const adminUser = {
      userId: new Types.ObjectId().toString(),
      role: "admin",
    } as any;

    it("throws BadRequestException for invalid eventId", async () => {
      await expect(
        service.getAllBookings(
          { ...baseQuery, eventId: "bad-id" } as any,
          adminUser
        )
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException for invalid sortBy field", async () => {
      await expect(
        service.getAllBookings(
          { ...baseQuery, sortBy: "invalidField" } as any,
          adminUser
        )
      ).rejects.toThrow(BadRequestException);
    });

    it("returns cached data when available", async () => {
      const cachedData = {
        items: [],
        meta: {
          totalItems: 0,
          currentPage: 1,
          itemsPerPage: 20,
          totalPages: 0,
          hasPreviousPage: false,
          hasNextPage: false,
        },
      };
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(JSON.stringify(cachedData));

      const result = await service.getAllBookings(baseQuery as any, adminUser);

      expect(result).toEqual(cachedData);
      expect(bookingModel.aggregate).not.toHaveBeenCalled();
    });

    it("queries DB and returns result with eventId filter", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);
      bookingModel.aggregate.mockResolvedValue([]);
      bookingModel.countDocuments.mockResolvedValue(0);

      const result = await service.getAllBookings(
        {
          ...baseQuery,
          eventId,
          status: "confirmed",
          paymentStatus: "paid",
        } as any,
        adminUser
      );

      expect(result.meta.totalItems).toBe(0);
      expect(bookingModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.any(Types.ObjectId),
          status: "confirmed",
          paymentStatus: "paid",
        })
      );
    });

    it("overlays each booking's snapshot onto its aggregated eventId/zoneId", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);
      bookingModel.aggregate.mockResolvedValue([
        {
          _id: new Types.ObjectId(),
          eventId: { title: "Live title (renamed since booking)" },
          zoneId: { name: "Live zone (renamed since booking)" },
          snapshot: {
            eventTitle: "Original title at booking time",
            location: "Original location",
            eventStartDate: new Date("2029-01-01"),
            eventEndDate: new Date("2029-01-02"),
            zoneName: "Original zone name",
          },
        },
      ]);
      bookingModel.countDocuments.mockResolvedValue(1);

      const result = await service.getAllBookings(baseQuery as any, adminUser);

      expect(result.items[0].event?.title).toBe(
        "Original title at booking time"
      );
      expect(result.items[0].zone?.name).toBe("Original zone name");
    });

    it("applies search filter when search term is provided", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);
      bookingModel.aggregate.mockResolvedValue([]);
      bookingModel.countDocuments.mockResolvedValue(0);

      await service.getAllBookings(
        { ...baseQuery, search: "BK001" } as any,
        adminUser
      );

      expect(bookingModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          $or: expect.arrayContaining([
            expect.objectContaining({
              bookingCode: expect.objectContaining({ $regex: "BK001" }),
            }),
          ]),
        })
      );
    });

    it("does not add $or when search is whitespace only", async () => {
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);
      bookingModel.aggregate.mockResolvedValue([]);
      bookingModel.countDocuments.mockResolvedValue(0);

      await service.getAllBookings(
        { ...baseQuery, search: "   " } as any,
        adminUser
      );

      expect(bookingModel.countDocuments).toHaveBeenCalledWith(
        expect.not.objectContaining({ $or: expect.anything() })
      );
    });

    it("organizer with an owned eventId passes the ownership check and scopes by that event", async () => {
      const organizerUser = {
        userId: new Types.ObjectId().toString(),
        role: "organizer",
      } as any;
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);
      bookingModel.aggregate.mockResolvedValue([]);
      bookingModel.countDocuments.mockResolvedValue(0);

      await service.getAllBookings(
        { ...baseQuery, eventId } as any,
        organizerUser
      );

      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        organizerUser,
        eventId
      );
    });

    it("organizer without eventId is scoped to only their managed events", async () => {
      const organizerUser = {
        userId: new Types.ObjectId().toString(),
        role: "organizer",
      } as any;
      const managedId = new Types.ObjectId();
      eventOwnershipService.getManagedEventIds.mockResolvedValueOnce([
        managedId,
      ]);
      const mockRedisClient = redisService.client;
      mockRedisClient.get.mockResolvedValue(null);
      bookingModel.aggregate.mockResolvedValue([]);
      bookingModel.countDocuments.mockResolvedValue(0);

      await service.getAllBookings(baseQuery as any, organizerUser);

      expect(bookingModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: { $in: [managedId] } })
      );
    });

    it("organizer managing zero events gets an empty page without querying the DB", async () => {
      const organizerUser = {
        userId: new Types.ObjectId().toString(),
        role: "organizer",
      } as any;
      eventOwnershipService.getManagedEventIds.mockResolvedValueOnce([]);

      const result = await service.getAllBookings(
        baseQuery as any,
        organizerUser
      );

      expect(result.items).toEqual([]);
      expect(result.meta.totalItems).toBe(0);
      expect(bookingModel.aggregate).not.toHaveBeenCalled();
    });

    it("propagates ForbiddenException when organizer does not manage the requested event", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      const organizerUser = {
        userId: new Types.ObjectId().toString(),
        role: "organizer",
      } as any;
      eventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.getAllBookings({ ...baseQuery, eventId } as any, organizerUser)
      ).rejects.toThrow(ForbiddenException);
      expect(bookingModel.aggregate).not.toHaveBeenCalled();
    });
  });

  describe("createBooking — per-user ticket limit (Bug 6)", () => {
    const baseDto = {
      eventId,
      zoneId,
      quantity: 2,
      customerEmail: "demo@example.com",
      customerName: "Demo",
    };

    it("rejects when user already holds MAX tickets for the event", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 100,
        hasSeating: false,
        isDeleted: false,
      });

      // User already has MAX_TICKETS_PER_USER_PER_EVENT - 1 active ticket quantity
      bookingModel.aggregate.mockReturnValue({
        session: jest
          .fn()
          .mockResolvedValue([
            { totalQuantity: MAX_TICKETS_PER_USER_PER_EVENT - 1 },
          ]),
      });

      // quantity: 2 → existing (9) + new (2) = 11 > 10 → should reject
      await expect(
        service.createBooking(userId, { ...baseDto, quantity: 2 } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("allows booking when user has room within the limit", async () => {
      mockCreateContext({
        _id: new Types.ObjectId(zoneId),
        eventId: new Types.ObjectId(eventId),
        price: 100,
        hasSeating: false,
        isDeleted: false,
      });

      // User has 8 ticket quantity, wants 2 more → 10 total = exactly at limit → allowed
      bookingModel.aggregate.mockReturnValue({
        session: jest.fn().mockResolvedValue([{ totalQuantity: 8 }]),
      });

      zoneModel.findOneAndUpdate.mockResolvedValue({
        _id: new Types.ObjectId(zoneId),
      });
      mockEmitZoneSnapshot();

      const result = await service.createBooking(userId, {
        ...baseDto,
        quantity: 2,
      } as any);

      expect(result.success).toBe(true);
    });
  });

  describe("adminCancelBooking — real refund trigger (Bug 1)", () => {
    const bookingId = new Types.ObjectId().toString();
    const adminId = new Types.ObjectId().toString();

    const setupAdminSession = () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);
      return session;
    };

    it("calls issueAdminRefund when a confirmed+paid booking is cancelled", async () => {
      setupAdminSession();

      const stripePaymentIntentId = "pi_test_abc123";
      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        quantity: 2,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId,
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      mockEmitZoneSnapshot();

      await service.adminCancelBooking(bookingId, adminId, "Event cancelled");

      expect(paymentService.issueAdminRefund).toHaveBeenCalledWith(
        bookingId,
        stripePaymentIntentId,
        adminId,
        "Event cancelled"
      );
    });

    it("releases promo usage in the same transaction for a confirmed+paid booking (#3 promo quota leak)", async () => {
      const session = setupAdminSession();

      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        quantity: 2,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId: "pi_test_promo_release",
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      mockEmitZoneSnapshot();

      await service.adminCancelBooking(bookingId, adminId, "Event cancelled");

      expect(promotionService.releaseUsageForBooking).toHaveBeenCalledWith(
        preUpdate._id,
        session
      );
    });

    it("aborts the transaction (rejects, no refund/notification side effects) when releasing promo usage fails", async () => {
      setupAdminSession();

      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        quantity: 2,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId: "pi_test_abort",
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      promotionService.releaseUsageForBooking.mockRejectedValueOnce(
        new Error("promotion usage write conflict")
      );

      await expect(
        service.adminCancelBooking(bookingId, adminId, "Event cancelled")
      ).rejects.toThrow("promotion usage write conflict");

      expect(paymentService.issueAdminRefund).not.toHaveBeenCalled();
    });

    it("does NOT call issueAdminRefund for a pending unpaid booking, but still releases promo usage as before (no regression)", async () => {
      const session = setupAdminSession();

      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        quantity: 1,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId: undefined,
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      mockEmitZoneSnapshot();

      await service.adminCancelBooking(bookingId, adminId);

      expect(paymentService.issueAdminRefund).not.toHaveBeenCalled();
      expect(promotionService.releaseUsageForBooking).toHaveBeenCalledWith(
        preUpdate._id,
        session
      );
    });

    it("throws NotFoundException when booking does not exist", async () => {
      setupAdminSession();
      bookingModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.adminCancelBooking(bookingId, adminId)
      ).rejects.toThrow(NotFoundException);
    });

    it("handles auditService.record failure gracefully", async () => {
      const _session = setupAdminSession();

      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        quantity: 1,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId: undefined,
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      zoneModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(zoneId),
            eventId: new Types.ObjectId(eventId),
            capacity: 100,
            soldCount: 50,
            confirmedSoldCount: 5,
          }),
        }),
      });

      auditService.record.mockRejectedValue(new Error("Audit DB unavailable"));

      const result = await service.adminCancelBooking(bookingId, adminId);

      expect(result).toEqual({ message: "Booking cancelled by admin" });
    });

    it("cleans up QR codes for tickets when cancelling a confirmed booking", async () => {
      const _session = setupAdminSession();

      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.CONFIRMED,
        paymentStatus: PaymentStatus.PAID,
        quantity: 2,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId: "pi_test_qr_123",
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.updateOne.mockResolvedValue({});
      const chainableQuery = {
        select: jest.fn().mockReturnThis(),
        session: jest.fn().mockReturnThis(),
        lean: jest
          .fn()
          .mockResolvedValue([
            { ticketCode: "TC001" },
            { ticketCode: "TC002" },
          ]),
      };
      ticketModel.find.mockReturnValue(chainableQuery);
      uploadService.deleteQRCode.mockRejectedValue(
        new Error("QR upload failed")
      );

      mockEmitZoneSnapshot();

      await service.adminCancelBooking(bookingId, adminId, "QR cleanup test");

      expect(uploadService.deleteQRCode).toHaveBeenCalledTimes(2);
      expect(uploadService.deleteQRCode).toHaveBeenCalledWith("TC001");
      expect(uploadService.deleteQRCode).toHaveBeenCalledWith("TC002");
    });

    it("skips zone updates when quantity is 0", async () => {
      const _session = setupAdminSession();

      const preUpdate = {
        _id: new Types.ObjectId(),
        userId: new Types.ObjectId(),
        status: BookingStatus.PENDING,
        paymentStatus: PaymentStatus.UNPAID,
        quantity: 0,
        zoneId: new Types.ObjectId(zoneId),
        stripePaymentIntentId: undefined,
      };

      bookingModel.findOneAndUpdate.mockResolvedValue(preUpdate);
      ticketModel.updateMany.mockResolvedValue({});
      zoneModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      });

      await service.adminCancelBooking(bookingId, adminId);

      expect(zoneModel.updateOne).not.toHaveBeenCalled();
    });
  });

  describe("cleanupOldBookings", () => {
    it("soft-deletes bookings and their tickets/payments", async () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);

      const ids = [new Types.ObjectId(), new Types.ObjectId()];
      // find returns documents with _id fields
      bookingModel.find = jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(ids.map((id) => ({ _id: id }))),
      });
      bookingModel.updateMany.mockResolvedValue({ modifiedCount: 2 });
      ticketModel.updateMany.mockResolvedValue({ modifiedCount: 3 });
      paymentModel.updateMany = jest
        .fn()
        .mockResolvedValue({ modifiedCount: 2 });

      const before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await service.cleanupOldBookings(before);

      // bookingModel.find called with cutoffFilter to collect IDs first
      expect(bookingModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ isDeleted: false }),
        { _id: 1 }
      );

      // bookingModel.updateMany uses { _id: { $in: ids } }, NOT original cutoffFilter
      expect(bookingModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ _id: { $in: ids } }),
        { $set: { isDeleted: true } },
        { session }
      );

      // tickets and payments are cleaned up
      expect(ticketModel.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ bookingId: { $in: ids }, isDeleted: false }),
        { $set: { isDeleted: true } },
        { session }
      );
    });

    it("does nothing when no bookings match cutoff", async () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);

      bookingModel.find = jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });

      const before = new Date();
      await service.cleanupOldBookings(before);

      expect(bookingModel.updateMany).not.toHaveBeenCalled();
    });

    it("re-throws error when transaction fails", async () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);
      session.withTransaction.mockRejectedValue(new Error("Cleanup failed"));

      const before = new Date();
      await expect(service.cleanupOldBookings(before)).rejects.toThrow(
        "Cleanup failed"
      );
    });

    it("returns early when updateMany modifiedCount is 0", async () => {
      const session = createSessionMock();
      bookingModel.db.startSession.mockResolvedValue(session);

      const ids = [new Types.ObjectId()];
      bookingModel.find = jest.fn().mockReturnValue({
        session: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(ids.map((id) => ({ _id: id }))),
      });
      bookingModel.updateMany.mockResolvedValue({ modifiedCount: 0 });

      const before = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      await service.cleanupOldBookings(before);

      expect(ticketModel.updateMany).not.toHaveBeenCalled();
    });
  });
});
