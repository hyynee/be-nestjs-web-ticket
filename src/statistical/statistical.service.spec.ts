import { BadRequestException, Logger, NotFoundException } from "@nestjs/common";
import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { Types } from "mongoose";
import { StatisticalService } from "./statistical.service";
import { Booking } from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Event } from "@src/schemas/event.schema";
import { RedisService } from "@src/redis/redis.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";

// ── Helpers ───────────────────────────────────────────────────────────────────

const eventId = new Types.ObjectId().toString();
const adminUser = {
  userId: new Types.ObjectId().toString(),
  role: "admin",
} as any;

const makeModels = () => {
  const paymentModel = {
    aggregate: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
  const bookingModel = {
    aggregate: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
  const ticketModel = {
    aggregate: jest.fn().mockResolvedValue([]),
    countDocuments: jest.fn().mockResolvedValue(0),
  };
  const eventModel = {
    findById: jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ title: "Test Event" }),
      }),
    }),
    aggregate: jest.fn().mockResolvedValue([]),
  };
  return { paymentModel, bookingModel, ticketModel, eventModel };
};

const makeRedis = (cachedValue: string | null = null) => ({
  client: {
    get: jest.fn().mockResolvedValue(cachedValue),
    set: jest.fn().mockResolvedValue("OK"),
    del: jest.fn().mockResolvedValue(1),
  },
});

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("StatisticalService", () => {
  let service: StatisticalService;
  let models: ReturnType<typeof makeModels>;
  let redisService: ReturnType<typeof makeRedis>;
  let eventOwnershipService: {
    assertCanManageEvent: jest.Mock;
    getManagedEventIds: jest.Mock;
  };

  beforeEach(async () => {
    models = makeModels();
    redisService = makeRedis();
    eventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        StatisticalService,
        { provide: getModelToken(Booking.name), useValue: models.bookingModel },
        { provide: getModelToken(Payment.name), useValue: models.paymentModel },
        { provide: getModelToken(Ticket.name), useValue: models.ticketModel },
        { provide: getModelToken(Event.name), useValue: models.eventModel },
        { provide: RedisService, useValue: redisService },
        {
          provide: EventOwnershipService,
          useValue: eventOwnershipService,
        },
      ],
    }).compile();

    service = module.get<StatisticalService>(StatisticalService);
  });

  afterEach(() => jest.clearAllMocks());

  // ── Service bootstraps ─────────────────────────────────────────────────────

  it("is defined", () => {
    expect(service).toBeDefined();
  });

  // ── withRedisCache: stale-while-revalidate (no busy-wait) ─────────────────

  describe("withRedisCache (stale-while-revalidate fix)", () => {
    it("returns cached value without calling compute when cache is warm", async () => {
      const cached = JSON.stringify([{ id: "evt1" }]);
      redisService.client.get.mockResolvedValue(cached);

      const result = await service.getHotEventsByRevenue();

      expect(models.paymentModel.aggregate).not.toHaveBeenCalled();
      expect(result).toEqual([{ id: "evt1" }]);
    });

    it("calls compute and caches result on cache miss", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([
        { id: "evt2", totalRevenue: 999 },
      ]);

      await service.getHotEventsByRevenue();

      expect(models.paymentModel.aggregate).toHaveBeenCalledTimes(1);
      expect(redisService.client.set).toHaveBeenCalled();
    });

    it("returns data even when Redis SET fails (graceful degradation)", async () => {
      redisService.client.get.mockResolvedValue(null);
      redisService.client.set.mockRejectedValue(
        new Error("Redis write failure")
      );
      models.paymentModel.aggregate.mockResolvedValue([{ id: "evt3" }]);

      // Should not throw — data is returned without caching
      await expect(service.getHotEventsByRevenue()).resolves.toBeTruthy();
    });

    it("falls through to DB when Redis GET fails", async () => {
      redisService.client.get.mockRejectedValue(
        new Error("Redis read failure")
      );
      models.paymentModel.aggregate.mockResolvedValue([]);

      await expect(service.getHotEventsByRevenue()).resolves.toBeDefined();
      expect(models.paymentModel.aggregate).toHaveBeenCalledTimes(1);
    });
  });

  // ── getOverviewStatistics input validation ─────────────────────────────────
  describe("getOverviewStatistics", () => {
    it("throws BadRequestException for invalid eventId format", async () => {
      await expect(
        service.getOverviewStatistics("not-a-valid-object-id")
      ).rejects.toThrow(BadRequestException);
    });

    it("accepts a valid ObjectId string", async () => {
      // The facet pipeline returns an array with one document containing facet branches
      const facetPayment = [{ total: [], currentMonth: [], previousMonth: [] }];
      const facetTicket = [{ total: [], currentMonth: [], previousMonth: [] }];
      const facetBooking = [{ total: [], paid: [] }];
      models.paymentModel.aggregate.mockResolvedValue(facetPayment);
      models.ticketModel.aggregate.mockResolvedValue(facetTicket);
      models.bookingModel.aggregate.mockResolvedValue(facetBooking);

      await expect(
        service.getOverviewStatistics(eventId)
      ).resolves.toBeDefined();
    });

    it("returns default zeros when aggregation returns empty arrays", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([
        { total: [], currentMonth: [], previousMonth: [] },
      ]);
      models.ticketModel.aggregate.mockResolvedValue([
        { total: [], currentMonth: [], previousMonth: [] },
      ]);
      models.bookingModel.aggregate.mockResolvedValue([
        { total: [], paid: [] },
      ]);

      const result = await service.getOverviewStatistics();
      expect(result.totalRevenue).toBe(0);
      expect(result.totalTicketsSold).toBe(0);
      expect(result.totalBookings).toBe(0);
    });

    it("bypasses cache and queries directly when startDate and endDate are provided", async () => {
      const facetPayment = [{ total: [], currentMonth: [], previousMonth: [] }];
      const facetTicket = [{ total: [], currentMonth: [], previousMonth: [] }];
      const facetBooking = [{ total: [], paid: [] }];
      models.paymentModel.aggregate.mockResolvedValue(facetPayment);
      models.ticketModel.aggregate.mockResolvedValue(facetTicket);
      models.bookingModel.aggregate.mockResolvedValue(facetBooking);

      const result = await service.getOverviewStatistics(
        eventId,
        "2025-01-01",
        "2025-12-31"
      );

      expect(redisService.client.get).not.toHaveBeenCalled();
      expect(result).toBeDefined();
    });

    it("returns 100% change when previous month revenue is 0 and current is non-zero", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([
        {
          total: [{ revenue: 500, refunded: 0 }],
          currentMonth: [{ total: 500 }],
          previousMonth: [{ total: 0 }],
        },
      ]);
      models.ticketModel.aggregate.mockResolvedValue([
        { total: [], currentMonth: [], previousMonth: [] },
      ]);
      models.bookingModel.aggregate.mockResolvedValue([
        { total: [], paid: [] },
      ]);

      const result = await service.getOverviewStatistics();
      expect(result.percentageChange).toBe(100);
    });

    it("calculates correct percentage change when previous month revenue is non-zero", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([
        {
          total: [],
          currentMonth: [{ total: 300 }],
          previousMonth: [{ total: 200 }],
        },
      ]);
      models.ticketModel.aggregate.mockResolvedValue([
        { total: [], currentMonth: [], previousMonth: [] },
      ]);
      models.bookingModel.aggregate.mockResolvedValue([
        { total: [], paid: [] },
      ]);

      const result = await service.getOverviewStatistics();
      expect(result.percentageChange).toBe(50);
    });
  });

  // ── getCheckInZones validation ─────────────────────────────────────────────

  describe("getCheckInZones", () => {
    it("throws BadRequestException for invalid eventId", async () => {
      await expect(
        service.getCheckInZones("bad-id", adminUser)
      ).rejects.toThrow(BadRequestException);
    });

    it("queries aggregate with a valid eventId", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.ticketModel.aggregate.mockResolvedValue([]);

      await service.getCheckInZones(eventId, adminUser);
      expect(models.ticketModel.aggregate).toHaveBeenCalledTimes(1);
    });

    it("checks event ownership before querying", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.ticketModel.aggregate.mockResolvedValue([]);

      await service.getCheckInZones(eventId, adminUser);

      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        adminUser,
        eventId
      );
    });

    it("propagates ForbiddenException from the ownership check without querying", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      eventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(service.getCheckInZones(eventId, adminUser)).rejects.toThrow(
        ForbiddenException
      );
      expect(models.ticketModel.aggregate).not.toHaveBeenCalled();
    });
  });

  // ── getRevenueStatistics ──────────────────────────────────────────────────
  describe("getRevenueStatistics", () => {
    it("returns revenue data grouped by month", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([
        { _id: { year: 2025, month: 1 }, totalRevenue: 1000, count: 5 },
        { _id: { year: 2025, month: 2 }, totalRevenue: 2000, count: 8 },
      ]);

      const result = await service.getRevenueStatistics(
        undefined,
        "2025-01-01",
        "2025-12-31",
        "month"
      );

      expect(result.data).toHaveLength(2);
      expect(result.data[0].label).toBe("2025-01");
      expect(result.data[0].revenue).toBe(1000);
    });

    it("returns revenue data grouped by day", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([
        { _id: { year: 2025, month: 1, day: 5 }, totalRevenue: 500, count: 2 },
      ]);

      const result = await service.getRevenueStatistics(
        eventId,
        "2025-01-01",
        "2025-01-31",
        "day"
      );

      expect(result.data[0].label).toBe("2025-01-05");
    });

    it("uses cached data when available", async () => {
      const cached = JSON.stringify({
        data: [{ label: "2025-01", revenue: 1000, count: 5 }],
      });
      redisService.client.get.mockResolvedValue(cached);

      const result = await service.getRevenueStatistics(
        undefined,
        "2025-01-01",
        "2025-12-31",
        "month"
      );

      expect(models.paymentModel.aggregate).not.toHaveBeenCalled();
      expect(result.data[0].revenue).toBe(1000);
    });
  });

  // ── getRevenueStatisticsByEvent validation ────────────────────────────────
  describe("getRevenueStatisticsByEvent", () => {
    it("throws when eventId is missing", async () => {
      await expect(
        service.getRevenueStatisticsByEvent(undefined, adminUser)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws for invalid ObjectId", async () => {
      await expect(
        service.getRevenueStatisticsByEvent("bad-id", adminUser)
      ).rejects.toThrow(BadRequestException);
    });

    it("returns event revenue data for a valid eventId", async () => {
      redisService.client.get.mockResolvedValue(null);
      const mockEvent = { _id: new Types.ObjectId(eventId), title: "My Event" };
      models.eventModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(mockEvent),
        }),
      });
      models.paymentModel.aggregate.mockResolvedValue([
        { _id: null, total: 15000 },
      ]);
      models.ticketModel.countDocuments.mockResolvedValue(30);

      const result = await service.getRevenueStatisticsByEvent(
        eventId,
        adminUser
      );

      expect(result.eventName).toBe("My Event");
      expect(result.totalRevenue).toBe(15000);
      expect(result.ticketsSold).toBe(30);
    });

    it("throws NotFoundException when event does not exist", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.eventModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(
        service.getRevenueStatisticsByEvent(eventId, adminUser)
      ).rejects.toThrow(NotFoundException);
    });

    it("checks event ownership before querying", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.eventModel.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: new Types.ObjectId(eventId),
            title: "My Event",
          }),
        }),
      });
      models.paymentModel.aggregate.mockResolvedValue([]);
      models.ticketModel.countDocuments.mockResolvedValue(0);

      await service.getRevenueStatisticsByEvent(eventId, adminUser);

      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        adminUser,
        eventId
      );
    });

    it("propagates ForbiddenException from the ownership check without querying", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      eventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.getRevenueStatisticsByEvent(eventId, adminUser)
      ).rejects.toThrow(ForbiddenException);
      expect(models.eventModel.findById).not.toHaveBeenCalled();
    });
  });

  // ── getTopSellingEvents ───────────────────────────────────────────────────
  describe("getTopSellingEvents", () => {
    it("defaults to 'tickets' sort", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.ticketModel.aggregate.mockResolvedValue([]);
      await service.getTopSellingEvents();
      expect(models.ticketModel.aggregate).toHaveBeenCalledTimes(1);
    });

    it("queries payments for revenue sort", async () => {
      redisService.client.get.mockResolvedValue(null);
      models.paymentModel.aggregate.mockResolvedValue([]);
      await service.getTopSellingEvents("revenue");
      expect(models.paymentModel.aggregate).toHaveBeenCalledTimes(1);
    });
  });

  // ── getTopPotentialCustomers ──────────────────────────────────────────────
  describe("getTopPotentialCustomers", () => {
    it("returns top potential customers from booking aggregation", async () => {
      redisService.client.get.mockResolvedValue(null);
      const mockUsers = [
        {
          userId: new Types.ObjectId(),
          name: "Alice",
          email: "a@b.com",
          totalBookings: 5,
          totalAmountSpent: 5000,
        },
      ];
      models.bookingModel.aggregate.mockResolvedValue(mockUsers);

      const result = await service.getTopPotentialCustomers();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("Alice");
      expect(result[0].totalAmountSpent).toBe(5000);
    });

    it("returns cached data when available", async () => {
      const cached = JSON.stringify([
        {
          userId: "abc",
          name: "Bob",
          email: "b@c.com",
          totalBookings: 3,
          totalAmountSpent: 3000,
        },
      ]);
      redisService.client.get.mockResolvedValue(cached);

      const result = await service.getTopPotentialCustomers();

      expect(models.bookingModel.aggregate).not.toHaveBeenCalled();
      expect(result[0].name).toBe("Bob");
    });
  });

  // ── warmGlobalCache ───────────────────────────────────────────────────────

  describe("warmGlobalCache", () => {
    it("resolves even when one sub-query fails", async () => {
      models.paymentModel.aggregate.mockRejectedValue(new Error("DB timeout"));
      models.ticketModel.aggregate.mockResolvedValue([]);
      models.bookingModel.aggregate.mockResolvedValue([]);

      await expect(service.warmGlobalCache()).resolves.not.toThrow();
    });

    it("runs all 5 data queries", async () => {
      models.paymentModel.aggregate.mockResolvedValue([]);
      models.ticketModel.aggregate.mockResolvedValue([]);
      models.bookingModel.aggregate.mockResolvedValue([]);

      await service.warmGlobalCache();

      // payment.aggregate is called for hot-events, top-selling-revenue, and overview
      expect(models.paymentModel.aggregate.mock.calls.length).toBeGreaterThan(
        0
      );
    });

    it("logs warn when Redis SET fails with non-Error in queryAndStore", async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, "warn")
        .mockImplementation(() => {});
      models.paymentModel.aggregate.mockResolvedValue([]);
      models.ticketModel.aggregate.mockResolvedValue([]);
      models.bookingModel.aggregate.mockResolvedValue([]);
      redisService.client.set.mockRejectedValue("string error");

      await service.warmGlobalCache();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unknown"));
      warnSpy.mockRestore();
    });
  });
});
