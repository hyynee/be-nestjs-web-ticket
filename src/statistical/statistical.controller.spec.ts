import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { StatisticalController } from "./statistical.controller";
import { StatisticalService } from "./statistical.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import {
  DashboardQueryDto,
  RevenueStatisticsQueryDto,
} from "./dto/dashboard-query.dto";
import {
  DashboardOverviewDto,
  RevenueStatisticsResponseDto,
} from "./dto/dashboard.dto";

describe("StatisticalController", () => {
  let controller: StatisticalController;
  let statisticalService: jest.Mocked<StatisticalService>;

  const mockEventId = "507f1f77bcf86cd799439011";
  const mockUser = {
    userId: "admin-1",
    role: "admin",
    iat: 0,
    exp: 0,
  } as any;
  const overviewResult: DashboardOverviewDto = {
    totalRevenue: 1000,
    totalTicketsSold: 50,
    totalBookings: 30,
    totalPaidBookings: 25,
    totalCheckedIn: 40,
    totalRefundedAmount: 100,
    currentMonthRevenue: 500,
    previousMonthRevenue: 400,
    revenueDifference: 100,
    percentageChange: 25,
    currentMonthTicketsSold: 20,
    previousMonthTicketsSold: 15,
    ticketsSoldPercentageChange: 33.33,
    currentMonthCheckedIn: 18,
    previousMonthCheckedIn: 12,
    checkedInPercentageChange: 50,
  };
  const revenueResult: RevenueStatisticsResponseDto = {
    data: [{ label: "2025-01", revenue: 1000 }],
  };
  const hotEventsResult = [
    { id: mockEventId, title: "Hot Event", totalRevenue: 5000 },
  ];
  const topSellingResult = [
    { eventId: mockEventId, eventName: "Top", ticketsSold: 100 },
  ];
  const potentialCustomersResult = [
    {
      userId: "u1",
      name: "John",
      email: "j@t.com",
      totalBookings: 5,
      totalAmountSpent: 2000,
    },
  ];
  const checkinZonesResult = [
    {
      zoneId: "z1",
      zoneName: "VIP",
      totalTickets: 50,
      checkedInCount: 40,
      notCheckedIn: 10,
      checkInRate: 80,
    },
  ];
  const revenueByEventResult = {
    eventId: mockEventId,
    eventName: "Event",
    totalRevenue: 3000,
    ticketsSold: 60,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [StatisticalController],
      providers: [
        {
          provide: StatisticalService,
          useValue: {
            getHotEventsByRevenue: jest.fn(),
            getTopSellingEvents: jest.fn(),
            getOverviewStatistics: jest.fn(),
            getRevenueStatistics: jest.fn(),
            getRevenueStatisticsByEvent: jest.fn(),
            getTopPotentialCustomers: jest.fn(),
            getCheckInZones: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<StatisticalController>(StatisticalController);
    statisticalService = module.get(StatisticalService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("getHotEventsByRevenue", () => {
    it("returns hot events", async () => {
      statisticalService.getHotEventsByRevenue.mockResolvedValue(
        hotEventsResult
      );

      const result = await controller.getHotEventsByRevenue();

      expect(statisticalService.getHotEventsByRevenue).toHaveBeenCalled();
      expect(result).toEqual(hotEventsResult);
    });
  });

  describe("getTopSellingEvents", () => {
    it("returns top selling events by tickets (default)", async () => {
      statisticalService.getTopSellingEvents.mockResolvedValue(
        topSellingResult
      );

      const result = await controller.getTopSellingEvents("tickets");

      expect(statisticalService.getTopSellingEvents).toHaveBeenCalledWith(
        "tickets"
      );
      expect(result).toEqual(topSellingResult);
    });

    it("returns top selling events by revenue", async () => {
      statisticalService.getTopSellingEvents.mockResolvedValue(
        topSellingResult
      );

      const result = await controller.getTopSellingEvents("revenue");

      expect(statisticalService.getTopSellingEvents).toHaveBeenCalledWith(
        "revenue"
      );
      expect(result).toEqual(topSellingResult);
    });

    it("defaults to tickets when no query param provided", async () => {
      statisticalService.getTopSellingEvents.mockResolvedValue(
        topSellingResult
      );

      const result = await controller.getTopSellingEvents();

      expect(statisticalService.getTopSellingEvents).toHaveBeenCalledWith(
        "tickets"
      );
      expect(result).toEqual(topSellingResult);
    });
  });

  describe("getOverviewStatistics", () => {
    it("returns overview statistics with all query params", async () => {
      const query: DashboardQueryDto = {
        eventId: mockEventId,
        startDate: "2025-01-01",
        endDate: "2025-12-31",
      };
      statisticalService.getOverviewStatistics.mockResolvedValue(
        overviewResult
      );

      const result = await controller.getOverviewStatistics(query);

      expect(statisticalService.getOverviewStatistics).toHaveBeenCalledWith(
        query.eventId,
        query.startDate,
        query.endDate
      );
      expect(result).toEqual(overviewResult);
    });

    it("returns overview statistics without optional params", async () => {
      const query: DashboardQueryDto = {};
      statisticalService.getOverviewStatistics.mockResolvedValue(
        overviewResult
      );

      const result = await controller.getOverviewStatistics(query);

      expect(statisticalService.getOverviewStatistics).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined
      );
      expect(result).toEqual(overviewResult);
    });
  });

  describe("getRevenueStatistics", () => {
    it("returns revenue statistics with all query params", async () => {
      const query: RevenueStatisticsQueryDto = {
        eventId: mockEventId,
        from: "2025-01-01",
        to: "2025-12-31",
        groupBy: "month",
      };
      statisticalService.getRevenueStatistics.mockResolvedValue(revenueResult);

      const result = await controller.getRevenueStatistics(query);

      expect(statisticalService.getRevenueStatistics).toHaveBeenCalledWith(
        query.eventId,
        query.from,
        query.to,
        query.groupBy
      );
      expect(result).toEqual(revenueResult);
    });

    it("uses defaults when optional query params are omitted", async () => {
      const query: RevenueStatisticsQueryDto = {
        from: "2025-01-01",
        to: "2025-01-31",
      };
      statisticalService.getRevenueStatistics.mockResolvedValue(revenueResult);

      const result = await controller.getRevenueStatistics(query);

      expect(statisticalService.getRevenueStatistics).toHaveBeenCalledWith(
        undefined,
        query.from,
        query.to,
        undefined
      );
      expect(result).toEqual(revenueResult);
    });
  });

  describe("getRevenueStatisticsByEvent", () => {
    it("returns revenue statistics for a specific event", async () => {
      statisticalService.getRevenueStatisticsByEvent.mockResolvedValue(
        revenueByEventResult
      );

      const result = await controller.getRevenueStatisticsByEvent(
        mockEventId,
        mockUser
      );

      expect(
        statisticalService.getRevenueStatisticsByEvent
      ).toHaveBeenCalledWith(mockEventId, mockUser);
      expect(result).toEqual(revenueByEventResult);
    });
  });

  describe("getTopPotentialCustomers", () => {
    it("returns top potential customers", async () => {
      statisticalService.getTopPotentialCustomers.mockResolvedValue(
        potentialCustomersResult
      );

      const result = await controller.getTopPotentialCustomers();

      expect(statisticalService.getTopPotentialCustomers).toHaveBeenCalled();
      expect(result).toEqual(potentialCustomersResult);
    });
  });

  describe("getCheckInZones", () => {
    it("returns check-in zone statistics for an event", async () => {
      statisticalService.getCheckInZones.mockResolvedValue(checkinZonesResult);

      const result = await controller.getCheckInZones(mockEventId, mockUser);

      expect(statisticalService.getCheckInZones).toHaveBeenCalledWith(
        mockEventId,
        mockUser
      );
      expect(result).toEqual(checkinZonesResult);
    });
  });

  describe("error propagation", () => {
    it("propagates errors from getHotEventsByRevenue", async () => {
      statisticalService.getHotEventsByRevenue.mockRejectedValue(
        new Error("Query failed")
      );
      await expect(controller.getHotEventsByRevenue()).rejects.toThrow(
        "Query failed"
      );
    });

    it("propagates errors from getTopSellingEvents", async () => {
      statisticalService.getTopSellingEvents.mockRejectedValue(
        new Error("No events found")
      );
      await expect(controller.getTopSellingEvents()).rejects.toThrow(
        "No events found"
      );
    });

    it("propagates errors from getOverviewStatistics", async () => {
      statisticalService.getOverviewStatistics.mockRejectedValue(
        new Error("Invalid event ID")
      );
      await expect(
        controller.getOverviewStatistics({} as DashboardQueryDto)
      ).rejects.toThrow("Invalid event ID");
    });

    it("propagates errors from getRevenueStatistics", async () => {
      statisticalService.getRevenueStatistics.mockRejectedValue(
        new Error("Date range invalid")
      );
      await expect(
        controller.getRevenueStatistics({} as RevenueStatisticsQueryDto)
      ).rejects.toThrow("Date range invalid");
    });

    it("propagates errors from getRevenueStatisticsByEvent", async () => {
      statisticalService.getRevenueStatisticsByEvent.mockRejectedValue(
        new Error("Event not found")
      );
      await expect(
        controller.getRevenueStatisticsByEvent("bad-id", mockUser)
      ).rejects.toThrow("Event not found");
    });

    it("propagates errors from getTopPotentialCustomers", async () => {
      statisticalService.getTopPotentialCustomers.mockRejectedValue(
        new Error("DB timeout")
      );
      await expect(controller.getTopPotentialCustomers()).rejects.toThrow(
        "DB timeout"
      );
    });

    it("propagates errors from getCheckInZones", async () => {
      statisticalService.getCheckInZones.mockRejectedValue(
        new Error("Invalid event ID")
      );
      await expect(
        controller.getCheckInZones("bad-id", mockUser)
      ).rejects.toThrow("Invalid event ID");
    });
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer for per-event revenue/checkin-zones", () => {
      expect(
        reflector.get(ROLES_KEY, controller.getRevenueStatisticsByEvent)
      ).toEqual(["admin", "organizer"]);
      expect(reflector.get(ROLES_KEY, controller.getCheckInZones)).toEqual([
        "admin",
        "organizer",
      ]);
    });

    it("keeps global aggregate endpoints admin-only", () => {
      expect(
        reflector.get(ROLES_KEY, controller.getHotEventsByRevenue)
      ).toEqual(["admin"]);
      expect(
        reflector.get(ROLES_KEY, controller.getOverviewStatistics)
      ).toEqual(["admin"]);
      expect(reflector.get(ROLES_KEY, controller.getRevenueStatistics)).toEqual(
        ["admin"]
      );
      expect(
        reflector.get(ROLES_KEY, controller.getTopPotentialCustomers)
      ).toEqual(["admin"]);
    });
  });
});
