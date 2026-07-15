import { BadRequestException, NotFoundException } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import { SeatMapService } from "./seat-map.service";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Booking, SeatLock } from "@src/schemas/booking.schema";
import { SeatState, SeatBlockStatus } from "@src/schemas/seat-state.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { AuditService } from "@src/audit/audit.service";
import { ZoneGateway } from "@src/zone/zone.gateway";

describe("SeatMapService", () => {
  let service: SeatMapService;

  const eventId = new Types.ObjectId();
  const zoneId = new Types.ObjectId();
  const areaId = new Types.ObjectId();
  const userId = new Types.ObjectId().toString();
  const adminUser = { userId, role: "admin" };

  let zoneModel: any;
  let areaModel: any;
  let bookingModel: any;
  let seatLockModel: any;
  let seatStateModel: any;
  let mockEventOwnershipService: any;
  let mockAuditService: any;
  let mockZoneGateway: any;

  const chainableEmpty = () => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([]),
  });

  beforeEach(async () => {
    zoneModel = {
      find: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      findOne: jest.fn(),
    };

    areaModel = {
      find: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
      findOne: jest.fn(),
    };

    bookingModel = {
      find: jest.fn().mockReturnValue(chainableEmpty()),
    };

    seatLockModel = {
      find: jest.fn().mockReturnValue(chainableEmpty()),
    };

    seatStateModel = {
      find: jest.fn().mockReturnValue(chainableEmpty()),
      bulkWrite: jest.fn().mockResolvedValue({ ok: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ deletedCount: 0 }),
    };

    mockEventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    mockZoneGateway = {
      emitSeatMapUpdate: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SeatMapService,
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Area.name), useValue: areaModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(SeatLock.name), useValue: seatLockModel },
        { provide: getModelToken(SeatState.name), useValue: seatStateModel },
        { provide: EventOwnershipService, useValue: mockEventOwnershipService },
        { provide: AuditService, useValue: mockAuditService },
        { provide: ZoneGateway, useValue: mockZoneGateway },
      ],
    }).compile();

    service = module.get(SeatMapService);
  });

  describe("getEventSeatMap", () => {
    it("throws BadRequestException for an invalid event ID", async () => {
      await expect(service.getEventSeatMap("not-an-id")).rejects.toThrow(
        BadRequestException
      );
    });

    it("returns a summary (no areas) for a non-seating zone", async () => {
      zoneModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: zoneId,
            name: "General",
            hasSeating: false,
            capacity: 100,
            soldCount: 30,
          },
        ]),
      });

      const result = await service.getEventSeatMap(eventId.toString());

      expect(result).toEqual([
        {
          zoneId,
          zoneName: "General",
          hasSeating: false,
          capacity: 100,
          soldCount: 30,
          availableTickets: 70,
        },
      ]);
      expect(areaModel.find).not.toHaveBeenCalled();
    });

    it("clamps availableTickets to 0 when soldCount exceeds capacity", async () => {
      zoneModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: zoneId,
            name: "General",
            hasSeating: false,
            capacity: 10,
            soldCount: 15,
          },
        ]),
      });

      const [zone] = await service.getEventSeatMap(eventId.toString());
      expect(zone.availableTickets).toBe(0);
    });

    it("computes per-seat status for a seating zone with areas", async () => {
      zoneModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: zoneId,
            name: "VIP",
            hasSeating: true,
            capacity: 3,
            soldCount: 1,
          },
        ]),
      });
      areaModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: areaId,
            eventId,
            zoneId,
            name: "Row A",
            seats: ["A1", "A2", "A3"],
          },
        ]),
      });
      seatLockModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ seat: "A2" }]),
      });
      bookingModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ seats: ["A1"] }]),
      });
      seatStateModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });

      const [zone] = await service.getEventSeatMap(eventId.toString());

      expect(zone.areas).toEqual([
        {
          areaId,
          areaName: "Row A",
          seats: [
            { seat: "A1", status: "sold" },
            { seat: "A2", status: "holding" },
            { seat: "A3", status: "available" },
          ],
        },
      ]);
    });

    it("prioritizes disabled/blocked overrides over sold/holding state", async () => {
      zoneModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: zoneId,
            name: "VIP",
            hasSeating: true,
            capacity: 3,
            soldCount: 1,
          },
        ]),
      });
      areaModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: areaId,
            eventId,
            zoneId,
            name: "Row A",
            seats: ["A1", "A2"],
          },
        ]),
      });
      seatLockModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ seat: "A2" }]),
      });
      bookingModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([{ seats: ["A1"] }]),
      });
      seatStateModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([
          { seat: "A1", status: SeatBlockStatus.DISABLED },
          { seat: "A2", status: SeatBlockStatus.BLOCKED },
        ]),
      });

      const [zone] = await service.getEventSeatMap(eventId.toString());

      expect(zone.areas![0].seats).toEqual([
        { seat: "A1", status: "disabled" },
        { seat: "A2", status: "blocked" },
      ]);
    });

    it("excludes expired SeatState overrides from the query, so a lapsed block reads as available instead of waiting for Mongo's TTL cleanup", async () => {
      zoneModel.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          {
            _id: zoneId,
            name: "VIP",
            hasSeating: true,
            capacity: 3,
            soldCount: 0,
          },
        ]),
      });
      areaModel.find.mockReturnValue({
        lean: jest
          .fn()
          .mockResolvedValue([
            { _id: areaId, eventId, zoneId, name: "Row A", seats: ["A1"] },
          ]),
      });

      await service.getEventSeatMap(eventId.toString());

      const [filter] = seatStateModel.find.mock.calls[0];
      expect(filter.$or).toEqual([
        { expiresAt: { $exists: false } },
        { expiresAt: { $gt: expect.any(Date) } },
      ]);
    });
  });

  describe("getZoneSeatMap", () => {
    it("throws NotFoundException when the zone does not exist", async () => {
      zoneModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      await expect(service.getZoneSeatMap(zoneId.toString())).rejects.toThrow(
        NotFoundException
      );
    });

    it("returns the zone seat map when found", async () => {
      zoneModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: zoneId,
          name: "General",
          hasSeating: false,
          capacity: 5,
          soldCount: 2,
        }),
      });

      const result = await service.getZoneSeatMap(zoneId.toString());
      expect(result.zoneId).toBe(zoneId);
      expect(result.availableTickets).toBe(3);
    });
  });

  describe("blockSeats", () => {
    const dto = {
      zoneId: zoneId.toString(),
      areaId: areaId.toString(),
      seats: ["A1", "A2"],
      reason: "Maintenance",
    };

    it("delegates ownership check via the resolved area's eventId", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1", "A2"],
        }),
      });

      await service.blockSeats(adminUser as any, dto as any);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(adminUser, eventId.toString());
    });

    it("throws NotFoundException when the area does not exist", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.blockSeats(adminUser as any, dto as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when a requested seat is not part of the area", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });

      await expect(
        service.blockSeats(adminUser as any, dto as any)
      ).rejects.toThrow(BadRequestException);
      expect(seatStateModel.bulkWrite).not.toHaveBeenCalled();
    });

    it("upserts a SeatState per seat, records audit, and emits a realtime update", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1", "A2"],
        }),
      });

      const result = await service.blockSeats(adminUser as any, dto as any);

      expect(seatStateModel.bulkWrite).toHaveBeenCalledTimes(1);
      const ops = seatStateModel.bulkWrite.mock.calls[0][0];
      expect(ops).toHaveLength(2);
      expect(ops[0].updateOne.filter).toEqual({
        eventId,
        zoneId,
        areaId,
        seat: "A1",
      });
      expect(ops[0].updateOne.upsert).toBe(true);
      expect(ops[0].updateOne.update.$set.status).toBe(SeatBlockStatus.BLOCKED);

      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "seat.block",
          actorId: userId,
          eventId: eventId.toString(),
        })
      );
      expect(mockZoneGateway.emitSeatMapUpdate).toHaveBeenCalledWith({
        eventId,
        zoneId,
        areaId,
        seats: [
          { seat: "A1", status: SeatBlockStatus.BLOCKED },
          { seat: "A2", status: SeatBlockStatus.BLOCKED },
        ],
      });
      expect(result.seats).toHaveLength(2);
    });

    it("uses the explicit status (e.g. disabled) instead of defaulting to blocked", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });

      await service.blockSeats(
        adminUser as any,
        {
          ...dto,
          seats: ["A1"],
          status: SeatBlockStatus.DISABLED,
        } as any
      );

      const ops = seatStateModel.bulkWrite.mock.calls[0][0];
      expect(ops[0].updateOne.update.$set.status).toBe(
        SeatBlockStatus.DISABLED
      );
    });

    it("clears a previous expiresAt via $unset when re-blocking without one ($set: undefined would be silently dropped by the Mongo driver, leaving the stale expiry in place)", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });

      await service.blockSeats(
        adminUser as any,
        {
          ...dto,
          seats: ["A1"],
        } as any
      );

      const ops = seatStateModel.bulkWrite.mock.calls[0][0];
      expect(ops[0].updateOne.update.$set.expiresAt).toBeUndefined();
      expect(ops[0].updateOne.update.$unset).toEqual({ expiresAt: "" });
    });

    it("sets expiresAt directly (no $unset) when a future expiresAt is provided", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });
      const future = new Date(Date.now() + 60_000).toISOString();

      await service.blockSeats(
        adminUser as any,
        {
          ...dto,
          seats: ["A1"],
          expiresAt: future,
        } as any
      );

      const ops = seatStateModel.bulkWrite.mock.calls[0][0];
      expect(ops[0].updateOne.update.$set.expiresAt).toEqual(new Date(future));
      expect(ops[0].updateOne.update.$unset).toBeUndefined();
    });

    it("rejects an expiresAt that is not in the future", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });
      const past = new Date(Date.now() - 60_000).toISOString();

      await expect(
        service.blockSeats(
          adminUser as any,
          {
            ...dto,
            seats: ["A1"],
            expiresAt: past,
          } as any
        )
      ).rejects.toThrow(BadRequestException);
      expect(seatStateModel.bulkWrite).not.toHaveBeenCalled();
    });
  });

  describe("unblockSeats", () => {
    const dto = {
      zoneId: zoneId.toString(),
      areaId: areaId.toString(),
      seats: ["A1"],
    };

    it("removes the SeatState overrides, records audit, and emits the recomputed status", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });
      seatLockModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });
      bookingModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });
      seatStateModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue([]),
      });

      const result = await service.unblockSeats(adminUser as any, dto as any);

      expect(seatStateModel.deleteMany).toHaveBeenCalledWith({
        eventId,
        zoneId,
        areaId,
        seat: { $in: ["A1"] },
      });
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "seat.unblock",
          eventId: eventId.toString(),
        })
      );
      expect(result.seats).toEqual([{ seat: "A1", status: "available" }]);
      expect(mockZoneGateway.emitSeatMapUpdate).toHaveBeenCalledWith({
        eventId,
        zoneId,
        areaId,
        seats: [{ seat: "A1", status: "available" }],
      });
    });

    it("propagates ForbiddenException from the ownership check without deleting anything", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new Error("forbidden")
      );

      await expect(
        service.unblockSeats(adminUser as any, dto as any)
      ).rejects.toThrow();
      expect(seatStateModel.deleteMany).not.toHaveBeenCalled();
    });

    it("rejects a seat that does not exist in the area instead of deleting/emitting a fake status for it", async () => {
      areaModel.findOne.mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          _id: areaId,
          eventId,
          zoneId,
          name: "Row A",
          seats: ["A1"],
        }),
      });

      await expect(
        service.unblockSeats(
          adminUser as any,
          {
            ...dto,
            seats: ["X999"],
          } as any
        )
      ).rejects.toThrow(BadRequestException);
      expect(seatStateModel.deleteMany).not.toHaveBeenCalled();
      expect(mockZoneGateway.emitSeatMapUpdate).not.toHaveBeenCalled();
    });
  });
});
