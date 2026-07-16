import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { ExportService } from "./export.service";
import { Ticket } from "@src/schemas/ticket.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Types } from "mongoose";
import { exportCSV, exportExcel } from "@src/helper/export.helper";

jest.mock("@src/helper/export.helper", () => ({
  exportCSV: jest.fn().mockReturnValue("csv-content"),
  exportExcel: jest.fn().mockResolvedValue(undefined),
}));

const mockResponse = () => {
  const res: any = {};
  res.setHeader = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  res.status = jest.fn().mockReturnValue(res);
  return res;
};

describe("ExportService", () => {
  let service: ExportService;
  let ticketModel: any;
  let zoneModel: any;
  let mockQueueService: any;
  let mockEventOwnershipService: any;

  beforeEach(async () => {
    ticketModel = {
      find: jest.fn(),
      countDocuments: jest.fn(),
    };

    zoneModel = {
      find: jest.fn(),
    };

    mockQueueService = {
      addJob: jest.fn().mockResolvedValue(undefined),
    };

    mockEventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ExportService,
        { provide: getModelToken(Ticket.name), useValue: ticketModel },
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        {
          provide: require("@src/queue/queue.service").QueueService,
          useValue: mockQueueService,
        },
        {
          provide: require("@src/event/event-ownership.service")
            .EventOwnershipService,
          useValue: mockEventOwnershipService,
        },
      ],
    }).compile();

    service = module.get<ExportService>(ExportService);
    jest.clearAllMocks();
  });

  // ── Private helper for chained model calls ──

  const makeFindChain = (resolvedValue: any) => ({
    populate: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  });

  const makeLeanChain = (resolvedValue: any) => ({
    lean: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue(resolvedValue),
  });

  // ── getTicketData ───────────────────────────────────────────────────────

  describe("getTicketData", () => {
    const mockTickets = [
      {
        ticketCode: "TK001",
        eventId: { title: "Concert" },
        zoneId: { name: "VIP" },
        userId: { email: "a@a.com", name: "Alice" },
        seatNumber: "A1",
        price: 100,
        status: "valid",
        checkedInAt: null,
        checkInLocation: null,
        createdAt: new Date("2030-01-01"),
      },
    ];

    it("builds filter with eventId", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(ticketModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          isDeleted: false,
          eventId: expect.any(Types.ObjectId),
        })
      );
    });

    it("builds filter without eventId", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        format: "csv",
      });

      const filterArg = (ticketModel.find as jest.Mock).mock.calls[0][0];
      expect(filterArg.isDeleted).toBe(false);
      expect(filterArg.eventId).toBeUndefined();
    });

    it("builds filter with status", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
        status: "valid",
      });

      expect(ticketModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ status: "valid" })
      );
    });

    it("builds filter with zoneId", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
        zoneId: new Types.ObjectId().toString(),
      });

      expect(ticketModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ zoneId: expect.any(Types.ObjectId) })
      );
    });

    it("builds filter with only startDate", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
        startDate: "2030-01-01",
      });

      expect(ticketModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: { $gte: expect.any(Date) },
        })
      );
    });

    it("builds filter with only endDate", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
        endDate: "2030-01-31",
      });

      expect(ticketModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: { $lte: expect.any(Date) },
        })
      );
    });

    it("builds filter with date range", async () => {
      ticketModel.find.mockReturnValue(makeFindChain([]));

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
        startDate: "2030-01-01",
        endDate: "2030-01-31",
      });

      expect(ticketModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          createdAt: {
            $gte: expect.any(Date),
            $lte: expect.any(Date),
          },
        })
      );
    });

    it("maps ticket fields to export rows", async () => {
      ticketModel.find.mockReturnValue(makeFindChain(mockTickets));

      const result = await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result).toHaveLength(1);
      expect(result[0].ticketCode).toBe("TK001");
      expect(result[0].eventTitle).toBe("Concert");
      expect(result[0].zoneName).toBe("VIP");
      expect(result[0].userEmail).toBe("a@a.com");
      expect(result[0].userName).toBe("Alice");
      expect(result[0].seatNumber).toBe("A1");
      expect(result[0].price).toBe(100);
      expect(result[0].status).toBe("valid");
    });

    it("prefers the booking's snapshot over the live-populated event/zone when present", async () => {
      const ticketWithSnapshot = [
        {
          ...mockTickets[0],
          eventId: { title: "Live title (renamed since booking)" },
          zoneId: { name: "Live zone (renamed since booking)" },
          bookingId: {
            snapshot: {
              eventTitle: "Original title at booking time",
              zoneName: "Original zone at booking time",
            },
          },
        },
      ];
      ticketModel.find.mockReturnValue(makeFindChain(ticketWithSnapshot));

      const result = await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result[0].eventTitle).toBe("Original title at booking time");
      expect(result[0].zoneName).toBe("Original zone at booking time");
    });

    it("handles missing populated references", async () => {
      const ticketWithNullRefs = [
        {
          ticketCode: "TK002",
          eventId: null,
          zoneId: null,
          userId: null,
          seatNumber: null,
          price: 50,
          status: "used",
          checkedInAt: new Date("2030-01-15"),
          checkInLocation: "Gate A",
          createdAt: new Date("2030-01-01"),
        },
      ];

      ticketModel.find.mockReturnValue(makeFindChain(ticketWithNullRefs));

      const result = await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result[0].eventTitle).toBe("N/A");
      expect(result[0].zoneName).toBe("N/A");
      expect(result[0].userEmail).toBe("N/A");
      expect(result[0].userName).toBe("N/A");
      expect(result[0].seatNumber).toBe("N/A");
      expect(result[0].checkedInAt).not.toBe("Not checked in");
      expect(result[0].checkInLocation).toBe("Gate A");
    });

    it("formats checkedInAt as 'Not checked in' when null", async () => {
      ticketModel.find.mockReturnValue(makeFindChain(mockTickets));

      const result = await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result[0].checkedInAt).toBe("Not checked in");
    });

    it("handles null createdAt by falling back to new Date", async () => {
      const ticketWithNullCreatedAt = [
        {
          ticketCode: "TK003",
          eventId: { title: "Concert" },
          zoneId: { name: "VIP" },
          userId: { email: "a@a.com", name: "Alice" },
          seatNumber: "A1",
          price: 100,
          status: "valid",
          checkedInAt: null,
          checkInLocation: null,
          createdAt: null,
        },
      ];

      ticketModel.find.mockReturnValue(makeFindChain(ticketWithNullCreatedAt));

      const result = await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result).toHaveLength(1);
      expect(typeof result[0].createdAt).toBe("string");
    });

    it("populates eventId, zoneId, and userId", async () => {
      const chain = makeFindChain([]);
      ticketModel.find.mockReturnValue(chain);

      await (service as any).getTicketData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(chain.populate).toHaveBeenCalledTimes(4);
      expect(chain.populate).toHaveBeenCalledWith("eventId", "title");
      expect(chain.populate).toHaveBeenCalledWith("zoneId", "name");
      expect(chain.populate).toHaveBeenCalledWith("userId", "email name");
      expect(chain.populate).toHaveBeenCalledWith("bookingId", "snapshot");
    });
  });

  // ── getCheckInZoneData ──────────────────────────────────────────────────

  describe("getCheckInZoneData", () => {
    const mockZones = [
      { _id: new Types.ObjectId(), name: "VIP", capacity: 100 },
      { _id: new Types.ObjectId(), name: "Normal", capacity: 200 },
    ];

    it("queries zones and counts check-ins", async () => {
      zoneModel.find.mockReturnValue(makeLeanChain(mockZones));
      ticketModel.countDocuments
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(20);

      const result = await (service as any).getCheckInZoneData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result).toHaveLength(2);
      expect(result[0].zoneName).toBe("VIP");
      expect(result[0].totalCheckIns).toBe(10);
      expect(result[0].capacity).toBe(100);
      expect(result[1].zoneName).toBe("Normal");
      expect(result[1].totalCheckIns).toBe(20);
      expect(result[1].capacity).toBe(200);
      expect(ticketModel.countDocuments).toHaveBeenCalledTimes(2);
    });

    it("handles zone with null name and capacity", async () => {
      const nullZone = [
        { _id: new Types.ObjectId(), name: undefined, capacity: null },
      ];
      zoneModel.find.mockReturnValue(makeLeanChain(nullZone));
      ticketModel.countDocuments.mockResolvedValueOnce(0);

      const result = await (service as any).getCheckInZoneData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(result[0].zoneName).toBe("N/A");
      expect(result[0].capacity).toBe("N/A");
    });

    it("counts only tickets with status 'used' and isDeleted false", async () => {
      zoneModel.find.mockReturnValue(makeLeanChain(mockZones));
      ticketModel.countDocuments.mockResolvedValue(5);

      await (service as any).getCheckInZoneData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      });

      expect(ticketModel.countDocuments).toHaveBeenCalledWith({
        zoneId: expect.any(Types.ObjectId),
        status: "used",
        isDeleted: false,
      });
    });
  });

  // ── exportByFormat ──────────────────────────────────────────────────────

  describe("exportByFormat", () => {
    it("exports CSV format with data", async () => {
      const res = mockResponse();
      const data = [{ ticketCode: "TK1", status: "valid" }];

      await (service as any).exportByFormat(data, "csv", res, "tickets");

      expect(exportCSV).toHaveBeenCalledWith(data, ["ticketCode", "status"]);
      expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv");
      expect(res.send).toHaveBeenCalledWith("csv-content");
    });

    it("exports Excel format with data", async () => {
      const res = mockResponse();
      const data = [{ ticketCode: "TK1", status: "valid" }];

      await (service as any).exportByFormat(data, "xlsx", res, "tickets");

      expect(exportExcel).toHaveBeenCalledWith(
        data,
        [
          { header: "ticketCode", key: "ticketCode" },
          { header: "status", key: "status" },
        ],
        res,
        "tickets"
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    });

    it("exports empty CSV with message when data is empty", async () => {
      const res = mockResponse();

      await (service as any).exportByFormat([], "csv", res, "tickets");

      expect(exportCSV).toHaveBeenCalledWith(
        [{ message: "No data to export" }],
        ["message"]
      );
      expect(res.send).toHaveBeenCalledWith("csv-content");
    });

    it("exports empty Excel with message when data is empty", async () => {
      const res = mockResponse();

      await (service as any).exportByFormat([], "xlsx", res, "tickets");

      expect(exportExcel).toHaveBeenCalledWith(
        [{ message: "No data to export" }],
        [{ header: "message", key: "message" }],
        res,
        "tickets"
      );
    });

    it("exports CSV with null/undefined data gracefully", async () => {
      const res = mockResponse();

      await (service as any).exportByFormat(null, "csv", res, "tickets");

      expect(exportCSV).toHaveBeenCalledWith(
        [{ message: "No data to export" }],
        ["message"]
      );
    });
  });

  // ── exportTickets ───────────────────────────────────────────────────────

  describe("exportTickets", () => {
    const currentUser = { userId: "user-id", role: "admin" } as any;

    it("queues job and returns 202", async () => {
      const res = mockResponse();
      const dto = {
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      };

      await service.exportTickets(dto as any, currentUser, res);

      expect(mockQueueService.addJob).toHaveBeenCalledWith({
        type: "export-tickets",
        payload: { dto, requestedByUserId: "user-id" },
        requestedAt: expect.any(String),
      });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        message: expect.any(String),
        status: "queued",
      });
    });

    it("checks event ownership before queuing the export job", async () => {
      const res = mockResponse();
      const dto = { eventId: new Types.ObjectId().toString(), format: "csv" };

      await service.exportTickets(dto as any, currentUser, res);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(currentUser, dto.eventId);
    });

    it("propagates ForbiddenException from the ownership check without queuing", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      const res = mockResponse();
      const dto = { eventId: new Types.ObjectId().toString(), format: "csv" };
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.exportTickets(dto as any, currentUser, res)
      ).rejects.toThrow(ForbiddenException);
      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });

    it("queues job with all optional fields in dto", async () => {
      const res = mockResponse();
      const dto = {
        eventId: new Types.ObjectId().toString(),
        zoneId: new Types.ObjectId().toString(),
        status: "valid",
        startDate: "2030-01-01",
        endDate: "2030-01-31",
        format: "xlsx",
      };

      await service.exportTickets(dto as any, currentUser, res);

      expect(mockQueueService.addJob).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "export-tickets",
          payload: { dto, requestedByUserId: "user-id" },
        })
      );
    });
  });

  // ── exportCheckInZones ──────────────────────────────────────────────────

  describe("exportCheckInZones", () => {
    const currentUser = { userId: "user-id", role: "admin" } as any;

    it("queues job and returns 202", async () => {
      const res = mockResponse();
      const dto = {
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      };

      await service.exportCheckInZones(dto as any, currentUser, res);

      expect(mockQueueService.addJob).toHaveBeenCalledWith({
        type: "export-checkin-zones",
        payload: { dto, requestedByUserId: "user-id" },
        requestedAt: expect.any(String),
      });
      expect(res.status).toHaveBeenCalledWith(202);
      expect(res.json).toHaveBeenCalledWith({
        message: expect.any(String),
        status: "queued",
      });
    });

    it("checks event ownership before queuing the export job", async () => {
      const res = mockResponse();
      const dto = { eventId: new Types.ObjectId().toString(), format: "csv" };

      await service.exportCheckInZones(dto as any, currentUser, res);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(currentUser, dto.eventId);
    });

    it("propagates ForbiddenException from the ownership check without queuing", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      const res = mockResponse();
      const dto = { eventId: new Types.ObjectId().toString(), format: "csv" };
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.exportCheckInZones(dto as any, currentUser, res)
      ).rejects.toThrow(ForbiddenException);
      expect(mockQueueService.addJob).not.toHaveBeenCalled();
    });
  });

  // ── Public convenience methods ──────────────────────────────────────────

  describe("getTicketExportData", () => {
    it("fetches ticket data through actual implementation", async () => {
      const mockTickets = [
        {
          ticketCode: "TK001",
          eventId: { title: "Concert" },
          zoneId: { name: "VIP" },
          userId: { email: "a@a.com", name: "Alice" },
          seatNumber: "A1",
          price: 100,
          status: "valid",
          checkedInAt: null,
          checkInLocation: null,
          createdAt: new Date("2030-01-01"),
        },
      ];

      ticketModel.find.mockReturnValue(makeFindChain(mockTickets));

      const result = await service.getTicketExportData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      } as any);

      expect(result).toHaveLength(1);
      expect(result[0].ticketCode).toBe("TK001");
      expect(ticketModel.find).toHaveBeenCalled();
    });
  });

  describe("getCheckInZoneExportData", () => {
    it("fetches check-in zone data through actual implementation", async () => {
      const mockZones = [
        { _id: new Types.ObjectId(), name: "VIP", capacity: 100 },
      ];

      zoneModel.find.mockReturnValue(makeLeanChain(mockZones));
      ticketModel.countDocuments.mockResolvedValueOnce(5);

      const result = await service.getCheckInZoneExportData({
        eventId: new Types.ObjectId().toString(),
        format: "csv",
      } as any);

      expect(result).toHaveLength(1);
      expect(result[0].zoneName).toBe("VIP");
      expect(result[0].totalCheckIns).toBe(5);
    });
  });
});
