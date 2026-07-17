import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { ZoneService } from "./zone.service";
import { Zone } from "@src/schemas/zone.schema";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Area } from "@src/schemas/area.schema";
import { RedisService } from "@src/redis/redis.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { Types } from "mongoose";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ZoneCacheService } from "./infrastructure/cache/zone-cache.service";
import { ZonePresenter } from "./presenters/zone.presenter";

describe("ZoneService", () => {
  let service: ZoneService;
  let mockRedisClient: {
    scan: jest.Mock;
    del: jest.Mock;
    get: jest.Mock;
    set: jest.Mock;
    sAdd: jest.Mock;
    sMembers: jest.Mock;
    expire: jest.Mock;
  };
  let mockZoneModel: any;
  let mockEventModel: any;
  let mockAreaModel: any;
  let mockEventOwnershipService: any;

  beforeEach(async () => {
    mockRedisClient = {
      scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
      del: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      sAdd: jest.fn().mockResolvedValue(1),
      sMembers: jest.fn().mockResolvedValue([]),
      expire: jest.fn().mockResolvedValue(1),
    };

    const zoneInstance = {
      save: jest
        .fn()
        .mockResolvedValue({ _id: new Types.ObjectId(), name: "VIP" }),
    };
    mockZoneModel = jest.fn().mockImplementation(() => zoneInstance);
    mockZoneModel.findOne = jest.fn();
    mockZoneModel.find = jest.fn();
    mockZoneModel.findOneAndUpdate = jest.fn();
    mockZoneModel.countDocuments = jest.fn();
    mockZoneModel.aggregate = jest.fn();

    mockEventModel = {
      findOne: jest.fn(),
    };

    mockAreaModel = {
      find: jest.fn(),
      countDocuments: jest.fn(),
    };

    mockEventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ZoneService,
        ZoneCacheService,
        ZonePresenter,
        { provide: getModelToken(Zone.name), useValue: mockZoneModel },
        { provide: getModelToken(Event.name), useValue: mockEventModel },
        { provide: getModelToken(Area.name), useValue: mockAreaModel },
        { provide: RedisService, useValue: { client: mockRedisClient } },
        {
          provide: EventOwnershipService,
          useValue: mockEventOwnershipService,
        },
      ],
    }).compile();

    service = module.get<ZoneService>(ZoneService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  const zoneSource = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    eventId: new Types.ObjectId(),
    name: "VIP",
    price: 100,
    capacity: 50,
    currentTotalSeats: 0,
    soldCount: 0,
    confirmedSoldCount: 0,
    hasSeating: false,
    ...overrides,
  });

  const zoneAreaSource = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(),
    name: "A1",
    seats: [],
    seatCount: 0,
    ...overrides,
  });

  // ─── getAllActiveZones ────────────────────────────────────────────────

  describe("getAllActiveZones", () => {
    it("throws BadRequestException when eventId is invalid", async () => {
      await expect(
        service.getAllActiveZones({ eventId: "not-valid" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("returns cached data when available", async () => {
      const cachedResult = { items: [], meta: { totalItems: 0 } };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cachedResult));
      const result = await service.getAllActiveZones({
        eventId: new Types.ObjectId().toString(),
      } as any);
      expect(result).toEqual(cachedResult);
      expect(mockZoneModel.find).not.toHaveBeenCalled();
    });

    it("queries DB with filters when cache misses", async () => {
      const eventId = new Types.ObjectId().toString();
      const zones = [zoneSource({ eventId: new Types.ObjectId(eventId) })];
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(zones),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(1),
      });

      const result = await service.getAllActiveZones({
        eventId,
        page: 1,
        limit: 10,
      } as any);

      expect(result.items[0]).toEqual(
        expect.objectContaining({
          eventId,
          name: "VIP",
        })
      );
      expect(result.meta.totalItems).toBe(1);
      expect(mockZoneModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: expect.any(Types.ObjectId),
          isDeleted: false,
        })
      );
      expect(mockRedisClient.set).toHaveBeenCalled();
    });

    it("applies search and hasSeating filters", async () => {
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllActiveZones({
        search: "VIP",
        hasSeating: true,
        page: 1,
        limit: 10,
      } as any);

      expect(mockZoneModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          isDeleted: false,
          $or: expect.any(Array),
          hasSeating: true,
        })
      );
    });

    it("returns paginated results with correct meta", async () => {
      const zones = Array(5)
        .fill(null)
        .map(() => zoneSource());
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(zones),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(25),
      });

      const result = await service.getAllActiveZones({
        page: 2,
        limit: 10,
      } as any);

      expect(result.meta.currentPage).toBe(2);
      expect(result.meta.totalPages).toBe(3);
      expect(result.meta.hasPreviousPage).toBe(true);
      expect(result.meta.hasNextPage).toBe(true);
      expect(result.meta.itemsPerPage).toBe(10);
    });

    it("sorts ascending when sortOrder is asc", async () => {
      const sortMock = jest.fn().mockReturnThis();
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: sortMock,
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllActiveZones({ sortOrder: "asc" } as any);

      expect(sortMock).toHaveBeenCalledWith({ createdAt: 1 });
    });

    it("sorts by an allowed field when requested", async () => {
      const sortMock = jest.fn().mockReturnThis();
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: sortMock,
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllActiveZones({ sortBy: "price" } as any);

      expect(sortMock).toHaveBeenCalledWith({ price: -1 });
    });

    it("falls back to createdAt when sortBy is not in the whitelist", async () => {
      const sortMock = jest.fn().mockReturnThis();
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: sortMock,
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllActiveZones({
        sortBy: "password; DROP TABLE users;--",
      } as any);

      expect(sortMock).toHaveBeenCalledWith({ createdAt: -1 });
    });

    it("does not let an arbitrary sortBy explode the cache key", async () => {
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllActiveZones({ sortBy: "arbitraryField" } as any);
      const [cacheKeyA] = mockRedisClient.set.mock.calls.at(-1)!;

      await service.getAllActiveZones({
        sortBy: "anotherArbitraryField",
      } as any);
      const [cacheKeyB] = mockRedisClient.set.mock.calls.at(-1)!;

      expect(cacheKeyA).toBe(cacheKeyB);
    });

    it("falls through to DB when Redis cache get fails", async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error("Redis down"));
      const zones = [zoneSource({ name: "VIP" })];
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(zones),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(1),
      });

      const result = await service.getAllActiveZones({} as any);

      expect(result.items[0]).toEqual(expect.objectContaining({ name: "VIP" }));
      expect(mockZoneModel.find).toHaveBeenCalled();
    });

    it("continues when Redis cache set fails after query", async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);
      const zones = [zoneSource({ name: "VIP" })];
      mockZoneModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(zones),
      });
      mockZoneModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(1),
      });
      mockRedisClient.set.mockRejectedValueOnce(new Error("Redis down"));

      const result = await service.getAllActiveZones({} as any);

      expect(result.items[0]).toEqual(expect.objectContaining({ name: "VIP" }));
    });
  });

  // ─── getZoneWithAreas ─────────────────────────────────────────────────

  describe("getZoneWithAreas", () => {
    it("throws BadRequestException when zoneId is invalid", async () => {
      await expect(service.getZoneWithAreas("bad-id")).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws NotFoundException when zone not found", async () => {
      mockZoneModel.aggregate.mockResolvedValueOnce([]);
      await expect(
        service.getZoneWithAreas(new Types.ObjectId().toString())
      ).rejects.toThrow(NotFoundException);
    });

    it("returns zone with areas via aggregate", async () => {
      const zoneId = new Types.ObjectId().toString();
      const expected = zoneSource({
        _id: new Types.ObjectId(zoneId),
        name: "VIP",
        areas: [zoneAreaSource({ name: "A1" })],
      });
      mockZoneModel.aggregate.mockResolvedValueOnce([expected]);
      const result = await service.getZoneWithAreas(zoneId);
      expect(result).toEqual(
        expect.objectContaining({
          id: zoneId,
          name: "VIP",
          areas: [expect.objectContaining({ name: "A1" })],
        })
      );
    });
  });

  // ─── getZoneById ──────────────────────────────────────────────────────

  describe("getZoneById", () => {
    it("throws BadRequestException when id is invalid", async () => {
      await expect(service.getZoneById("bad-id")).rejects.toThrow(
        BadRequestException
      );
    });

    it("returns cached data when available", async () => {
      const cached = { _id: "some-zone-id", name: "VIP" };
      mockRedisClient.get.mockResolvedValueOnce(JSON.stringify(cached));
      const result = await service.getZoneById(new Types.ObjectId().toString());
      expect(result).toEqual(cached);
      expect(mockZoneModel.findOne).not.toHaveBeenCalled();
    });

    it("queries DB and caches result when cache misses", async () => {
      const zone = zoneSource({ name: "VIP" });
      mockZoneModel.findOne.mockResolvedValueOnce(zone);

      const zoneId = new Types.ObjectId().toString();
      const result = await service.getZoneById(zoneId);

      expect(result).toEqual(expect.objectContaining({ name: "VIP" }));
      expect(mockRedisClient.set).toHaveBeenCalledWith(
        `zone:detail:v1:${zoneId}`,
        JSON.stringify(result),
        { EX: 30 }
      );
    });

    it("throws BadRequestException when zone is not found", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getZoneById(new Types.ObjectId().toString())
      ).rejects.toThrow(BadRequestException);
    });

    it("falls through to DB when Redis cache get fails", async () => {
      mockRedisClient.get.mockRejectedValueOnce(new Error("Redis down"));
      const zone = zoneSource({ name: "VIP" });
      mockZoneModel.findOne.mockResolvedValueOnce(zone);

      const result = await service.getZoneById(new Types.ObjectId().toString());

      expect(result).toEqual(expect.objectContaining({ name: "VIP" }));
    });

    it("continues when Redis cache set fails after DB query", async () => {
      mockRedisClient.get.mockResolvedValueOnce(null);
      const zone = zoneSource({ name: "VIP" });
      mockZoneModel.findOne.mockResolvedValueOnce(zone);
      mockRedisClient.set.mockRejectedValueOnce(new Error("Redis down"));

      const result = await service.getZoneById(new Types.ObjectId().toString());

      expect(result).toEqual(expect.objectContaining({ name: "VIP" }));
    });
  });

  // ─── createZone ───────────────────────────────────────────────────────

  describe("createZone", () => {
    const validEventId = new Types.ObjectId().toString();
    const currentUser = { userId: "admin-id", role: "admin" } as any;
    const dto = {
      eventId: validEventId,
      name: "VIP",
      price: 100,
      capacity: 50,
      hasSeating: false,
    };

    const mockActiveEvent = () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: validEventId,
            status: EventStatus.ACTIVE,
          }),
        }),
      });
    };

    it("throws BadRequestException when eventId is invalid", async () => {
      await expect(
        service.createZone(currentUser, { ...dto, eventId: "bad" })
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when event not found", async () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest
          .fn()
          .mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
      });
      await expect(service.createZone(currentUser, dto as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws BadRequestException when event has ended", async () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: validEventId,
            status: EventStatus.ENDED,
          }),
        }),
      });
      await expect(service.createZone(currentUser, dto as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws BadRequestException when duplicate zone name exists", async () => {
      mockActiveEvent();
      mockZoneModel.findOne.mockResolvedValueOnce({
        _id: new Types.ObjectId(),
        name: "VIP",
      });
      await expect(service.createZone(currentUser, dto as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws BadRequestException on E11000 duplicate key error from save", async () => {
      mockActiveEvent();
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      const err = new Error("duplicate") as any;
      err.code = 11000;
      const instance = { save: jest.fn().mockRejectedValue(err) };
      mockZoneModel.mockImplementationOnce(() => instance);
      await expect(service.createZone(currentUser, dto as any)).rejects.toThrow(
        BadRequestException
      );
    });

    it("successfully creates a zone and invalidates cache", async () => {
      mockActiveEvent();
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      const savedZone = zoneSource({
        eventId: new Types.ObjectId(validEventId),
        name: "VIP",
        price: 100,
        capacity: 50,
        hasSeating: false,
      });
      const instance = { save: jest.fn().mockResolvedValue(savedZone) };
      mockZoneModel.mockImplementationOnce(() => instance);
      const invalidateSpy = jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);

      const result = await service.createZone(currentUser, dto as any);

      expect(result).toEqual(
        expect.objectContaining({
          eventId: validEventId,
          name: "VIP",
          price: 100,
          capacity: 50,
        })
      );
      expect(invalidateSpy).toHaveBeenCalled();
    });

    it("checks event ownership before creating the zone", async () => {
      mockActiveEvent();
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      const instance = {
        save: jest.fn().mockResolvedValue(
          zoneSource({
            eventId: new Types.ObjectId(validEventId),
            name: "VIP",
            price: 100,
            capacity: 50,
            hasSeating: false,
          })
        ),
      };
      mockZoneModel.mockImplementationOnce(() => instance);

      await service.createZone(currentUser, dto as any);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(currentUser, validEventId);
    });

    it("propagates ForbiddenException from the ownership check without creating a zone", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(service.createZone(currentUser, dto as any)).rejects.toThrow(
        ForbiddenException
      );
      expect(mockEventModel.findOne).not.toHaveBeenCalled();
    });
  });

  // ─── updateZone ───────────────────────────────────────────────────────

  describe("updateZone", () => {
    const validEventId = new Types.ObjectId().toString();
    const validZoneId = new Types.ObjectId().toString();
    const currentUser = { userId: "admin-id", role: "admin" } as any;
    const currentZone = {
      _id: new Types.ObjectId(validZoneId),
      eventId: new Types.ObjectId(validEventId),
      name: "VIP",
      price: 100,
      capacity: 50,
      currentTotalSeats: 0,
      soldCount: 0,
      confirmedSoldCount: 0,
      hasSeating: true,
    };

    const mockActiveEvent = () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: validEventId,
            status: EventStatus.ACTIVE,
          }),
        }),
      });
    };

    it("throws BadRequestException when eventId in updateDto is invalid", async () => {
      await expect(
        service.updateZone(currentUser, validZoneId, { eventId: "bad" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when zone id is invalid", async () => {
      await expect(
        service.updateZone(currentUser, "bad-id", { name: "VVIP" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when zone not found", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      await expect(
        service.updateZone(currentUser, validZoneId, {} as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when target event has ended", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: validEventId,
            status: EventStatus.ENDED,
          }),
        }),
      });
      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when duplicate name exists", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce({ _id: new Types.ObjectId(), name: "VVIP" });
      mockActiveEvent();
      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when disabling seating but active areas exist", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockActiveEvent();
      mockAreaModel.countDocuments.mockResolvedValueOnce(3);
      await expect(
        service.updateZone(currentUser, validZoneId, {
          hasSeating: false,
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("successfully updates zone and invalidates cache", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockActiveEvent();
      const updatedZone = { ...currentZone, name: "VVIP" };
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(updatedZone);
      const invalidateSpy = jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);

      const result = await service.updateZone(currentUser, validZoneId, {
        name: "VVIP",
      } as any);

      expect(result).toEqual(
        expect.objectContaining({
          id: validZoneId,
          eventId: validEventId,
          name: "VVIP",
        })
      );
      expect(invalidateSpy).toHaveBeenCalled();
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `zone:detail:v1:${validZoneId}`
      );
    });

    it("checks ownership of the zone's current event", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockActiveEvent();
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        ...currentZone,
      });

      await service.updateZone(currentUser, validZoneId, {
        name: "VVIP",
      } as any);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(currentUser, currentZone.eventId.toString());
    });

    it("also checks ownership of the destination event when moving the zone", async () => {
      const otherEventId = new Types.ObjectId().toString();
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            _id: otherEventId,
            status: EventStatus.ACTIVE,
          }),
        }),
      });
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        ...currentZone,
        eventId: new Types.ObjectId(otherEventId),
      });

      await service.updateZone(currentUser, validZoneId, {
        eventId: otherEventId,
      } as any);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(currentUser, currentZone.eventId.toString());
      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(currentUser, otherEventId);
    });

    it("propagates ForbiddenException from the ownership check without updating the zone", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow(ForbiddenException);
      expect(mockZoneModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("uses currentZone.eventId when eventId is not provided", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockActiveEvent();
      const updatedZone = { ...currentZone, description: "Updated" };
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(updatedZone);
      jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);

      const result = await service.updateZone(currentUser, validZoneId, {
        description: "Updated",
      } as any);

      expect(result).toEqual(
        expect.objectContaining({
          id: validZoneId,
          eventId: validEventId,
          description: "Updated",
        })
      );
    });

    it("passes when disabling seating with no active areas", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockActiveEvent();
      mockAreaModel.countDocuments.mockResolvedValueOnce(0);
      const updatedZone = { ...currentZone, hasSeating: false };
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(updatedZone);
      jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);

      const result = await service.updateZone(currentUser, validZoneId, {
        hasSeating: false,
      } as any);

      expect(result.hasSeating).toBe(false);
    });

    it("updates zone without name (only eventId)", async () => {
      mockZoneModel.findOne
        .mockResolvedValueOnce(currentZone)
        .mockResolvedValueOnce(null);
      mockActiveEvent();
      const updatedZone = { ...currentZone, eventId: new Types.ObjectId() };
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(updatedZone);
      jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);

      const result = await service.updateZone(currentUser, validZoneId, {
        eventId: validEventId,
      } as any);

      expect(result).toBeDefined();
    });

    it("throws BadRequestException when capacity is less than soldCount", async () => {
      const zoneWithSoldCount = { ...currentZone, soldCount: 50 };
      mockZoneModel.findOne
        .mockResolvedValueOnce(zoneWithSoldCount)
        .mockResolvedValueOnce(null);
      mockActiveEvent();

      await expect(
        service.updateZone(currentUser, validZoneId, { capacity: 30 } as any)
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ─── createZone edge cases ────────────────────────────────────────────
  describe("createZone – error handling edge cases", () => {
    const validEventId = new Types.ObjectId().toString();
    const currentUser = { userId: "admin-id", role: "admin" } as any;
    const dto = {
      eventId: validEventId,
      name: "VIP",
      price: 100,
      capacity: 50,
      hasSeating: false,
    };

    it("re-throws non-11000 error from save", async () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ _id: validEventId, status: "active" }),
        }),
      });
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      const dbError = new Error("Database connection lost");
      const instance = { save: jest.fn().mockRejectedValue(dbError) };
      mockZoneModel.mockImplementationOnce(() => instance);

      await expect(service.createZone(currentUser, dto as any)).rejects.toThrow(
        "Database connection lost"
      );
    });

    it("catches invalidateZoneCache rejection silently", async () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ _id: validEventId, status: "active" }),
        }),
      });
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      const savedZone = zoneSource({
        eventId: new Types.ObjectId(validEventId),
        name: "VIP",
        price: 100,
        capacity: 50,
        hasSeating: false,
      });
      const instance = { save: jest.fn().mockResolvedValue(savedZone) };
      mockZoneModel.mockImplementationOnce(() => instance);
      jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockRejectedValue(new Error("Cache invalidation error"));

      const result = await service.createZone(currentUser, dto as any);

      expect(result).toBeDefined();
    });
  });

  // ─── updateZone edge cases ────────────────────────────────────────────
  describe("updateZone – error handling edge cases", () => {
    const validEventId = new Types.ObjectId().toString();
    const validZoneId = new Types.ObjectId().toString();
    const currentUser = { userId: "admin-id", role: "admin" } as any;
    const currentZone = {
      _id: new Types.ObjectId(validZoneId),
      eventId: new Types.ObjectId(validEventId),
      hasSeating: true,
    };

    const mockActiveEvent = () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ _id: validEventId, status: "active" }),
        }),
      });
    };

    it("re-throws non-11000/11001 error from findOneAndUpdate", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      mockActiveEvent();
      const dbError = new Error("Transaction failed");
      mockZoneModel.findOneAndUpdate.mockRejectedValueOnce(dbError);

      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow("Transaction failed");
    });

    it("throws BadRequestException on MongoDB duplicate key error (11000)", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      mockActiveEvent();
      const dupError = new Error("Duplicate key") as any;
      dupError.code = 11000;
      mockZoneModel.findOneAndUpdate.mockRejectedValueOnce(dupError);

      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException on MongoDB duplicate key error (11001)", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      mockActiveEvent();
      const dupError = new Error("Duplicate key") as any;
      dupError.code = 11001;
      mockZoneModel.findOneAndUpdate.mockRejectedValueOnce(dupError);

      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("re-throws non-duplicate error from findOneAndUpdate without name (falls through to fallback label)", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockActiveEvent();
      mockZoneModel.findOneAndUpdate.mockRejectedValueOnce(
        new Error("Server error")
      );

      await expect(
        service.updateZone(currentUser, validZoneId, {} as any)
      ).rejects.toThrow("Server error");
    });

    it("throws BadRequestException on duplicate key error when updating eventId without name", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockActiveEvent();
      const dupError = new Error("Duplicate key") as any;
      dupError.code = 11000;
      mockZoneModel.findOneAndUpdate.mockRejectedValueOnce(dupError);

      await expect(
        service.updateZone(currentUser, validZoneId, {
          eventId: new Types.ObjectId().toString(),
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when findOneAndUpdate returns null", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      mockActiveEvent();
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.updateZone(currentUser, validZoneId, { name: "VVIP" } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("catches invalidateZoneCache rejection silently", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      mockActiveEvent();
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        ...currentZone,
        name: "VVIP",
      });
      jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockRejectedValue(new Error("Cache invalidation error"));

      const result = await service.updateZone(currentUser, validZoneId, {
        name: "VVIP",
      } as any);

      expect(result).toBeDefined();
    });

    it("catches detail cache del rejection silently in updateZone", async () => {
      mockZoneModel.findOne.mockResolvedValueOnce(currentZone);
      mockZoneModel.findOne.mockResolvedValueOnce(null);
      mockActiveEvent();
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        ...currentZone,
        name: "VVIP",
      });
      jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);
      mockRedisClient.del.mockRejectedValueOnce(new Error("Redis down"));

      const result = await service.updateZone(currentUser, validZoneId, {
        name: "VVIP",
      } as any);

      expect(result).toBeDefined();
    });
  });

  // ─── Cache invalidation ───────────────────────────────────────────────

  describe("cache invalidation", () => {
    const EVENT_ID = new Types.ObjectId().toString();

    it("createZone calls invalidateZoneCache on success", async () => {
      mockEventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest
            .fn()
            .mockResolvedValue({ _id: EVENT_ID, status: EventStatus.ACTIVE }),
        }),
      });
      mockZoneModel.findOne.mockResolvedValue(null);

      const invalidateSpy = jest
        .spyOn(service as any, "invalidateZoneCache")
        .mockResolvedValue(undefined);

      try {
        await service.createZone(
          { userId: "admin-id", role: "admin" } as any,
          {
            eventId: EVENT_ID,
            name: "VIP",
            price: 100,
            capacity: 50,
            hasSeating: false,
          } as any
        );
      } catch {
        // zone.save() may throw — we only verify invalidateZoneCache was called
      }

      expect(invalidateSpy).toHaveBeenCalled();
    });

    it("invalidateZoneCache uses Redis Set-based pattern", async () => {
      const listKeys = ["zones:list:event=all:page=1"];
      mockRedisClient.sMembers.mockResolvedValueOnce(listKeys);

      await (service as any).invalidateZoneCache();

      expect(mockRedisClient.sMembers).toHaveBeenCalledWith(
        "zones:list:index:v1"
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith([
        ...listKeys,
        "zones:list:index:v1",
      ]);
    });

    it("invalidateZoneCache does not throw when Redis is unavailable", async () => {
      mockRedisClient.sMembers.mockRejectedValueOnce(new Error("Redis down"));

      await expect(
        (service as any).invalidateZoneCache()
      ).resolves.not.toThrow();
    });
  });
});
