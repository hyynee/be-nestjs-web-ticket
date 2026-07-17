import { Test, TestingModule } from "@nestjs/testing";
import { AreaService } from "./area.service";
import { getModelToken, getConnectionToken } from "@nestjs/mongoose";
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { EventStatus } from "@src/schemas/event.schema";
import { RedisService } from "@src/redis/redis.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { MetricsService } from "@src/metrics/metrics.service";
import { ZoneService } from "@src/zone/zone.service";
import { AreaCommandService } from "./application/area-command.service";
import { AreaQueryService } from "./application/area-query.service";
import { AreaMutationPolicy } from "./domain/policies/area-mutation.policy";
import { AreaCacheService } from "./infrastructure/cache/area-cache.service";
import { AreaRepository } from "./infrastructure/persistence/area.repository";
import { AreaPresenter } from "./presenters/area.presenter";

describe("AreaService", () => {
  let service: AreaService;

  const VALID_ID = "64c1f2e1e1e1e1e1e1e1e1e1";
  const VALID_ZONE_ID = "64c1f2e1e1e1e1e1e1e1e1e2";
  const INVALID_ID = "invalid-id";

  const mockUser = { userId: "user123", role: "admin" };

  const mockEventOwnershipService = {
    assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
    getManagedEventIds: jest.fn().mockResolvedValue([]),
  };

  const mockZoneService = {
    invalidateZoneAvailabilityCache: jest.fn().mockResolvedValue(undefined),
  };

  const mockMetricsService = {
    zoneCapacityInconsistentTotal: { inc: jest.fn() },
    cacheInvalidationFailureTotal: { inc: jest.fn() },
  };

  const mockAreaModel = Object.assign(
    jest.fn().mockImplementation((data: any) => ({
      ...data,
      save: jest.fn().mockResolvedValue(undefined),
    })),
    {
      find: jest.fn(),
      findOne: jest.fn(),
      findOneAndUpdate: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
      aggregate: jest.fn(),
    }
  );

  const mockZoneModel = {
    findOne: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
  };

  const mockBookingModel = {
    countDocuments: jest.fn(),
  };

  const mockEventModel = {
    findOne: jest.fn(),
  };

  const mockRedisService = {
    client: {
      scan: jest.fn().mockResolvedValue({ cursor: 0, keys: [] }),
      del: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue("OK"),
      sMembers: jest.fn().mockResolvedValue([]),
      sAdd: jest.fn().mockResolvedValue(1),
      expire: jest.fn().mockResolvedValue(1),
    },
    scanKeys: jest.fn().mockResolvedValue([]),
  };

  let mockSession: any;

  const mockConnection = {
    startSession: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockSession = {
      withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
      endSession: jest.fn(),
    };
    mockConnection.startSession.mockResolvedValue(mockSession);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AreaService,
        AreaCommandService,
        AreaQueryService,
        AreaRepository,
        AreaPresenter,
        AreaCacheService,
        AreaMutationPolicy,
        { provide: getModelToken("Area"), useValue: mockAreaModel },
        { provide: getModelToken("Zone"), useValue: mockZoneModel },
        { provide: getModelToken("Booking"), useValue: mockBookingModel },
        { provide: getModelToken("Event"), useValue: mockEventModel },
        { provide: RedisService, useValue: mockRedisService },
        { provide: getConnectionToken(), useValue: mockConnection },
        {
          provide: EventOwnershipService,
          useValue: mockEventOwnershipService,
        },
        {
          provide: ZoneService,
          useValue: mockZoneService,
        },
        {
          provide: MetricsService,
          useValue: mockMetricsService,
        },
      ],
    }).compile();

    service = module.get<AreaService>(AreaService);
  });

  it("should be defined", () => {
    expect(service).toBeDefined();
  });

  const mockFindOneChain = (resolved: any) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    session: jest.fn().mockResolvedValue(resolved),
  });

  const mockEventFindOne = (resolved: any) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockReturnThis(),
    session: jest.fn().mockResolvedValue(resolved),
  });

  const areaSource = (overrides: Record<string, unknown> = {}) => ({
    _id: new Types.ObjectId(VALID_ID),
    eventId: new Types.ObjectId(VALID_ID),
    zoneId: new Types.ObjectId(VALID_ZONE_ID),
    name: "VIP",
    seats: [],
    seatCount: 0,
    ...overrides,
  });

  // ================= createArea =================
  describe("createArea", () => {
    const baseDto = {
      zoneId: VALID_ZONE_ID,
      name: "VIP",
      description: "VIP Area",
    };

    it("should throw if zoneId invalid", async () => {
      await expect(
        service.createArea(mockUser, { ...baseDto, zoneId: INVALID_ID })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if seatCount <= 0", async () => {
      await expect(
        service.createArea(mockUser, { ...baseDto, seatCount: -1 })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if seatCount > 0 without rowLabel and no seats", async () => {
      await expect(
        service.createArea(mockUser, { ...baseDto, seatCount: 5 })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if zone not found", async () => {
      mockZoneModel.findOne.mockReturnValue(mockFindOneChain(null));

      await expect(service.createArea(mockUser, baseDto)).rejects.toThrow(
        NotFoundException
      );
    });

    it("should throw if zone has no seating", async () => {
      mockZoneModel.findOne.mockReturnValue(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: false })
      );

      await expect(service.createArea(mockUser, baseDto)).rejects.toThrow(
        new ConflictException("This zone does not support seats/areas")
      );
    });

    it("checks event ownership using the zone's eventId", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );
      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: new Types.ObjectId(VALID_ZONE_ID),
        currentTotalSeats: 3,
      });
      mockAreaModel.create.mockResolvedValueOnce([
        areaSource({ seats: ["A1"], seatCount: 1 }),
      ]);

      await service.createArea(mockUser, {
        ...baseDto,
        seatCount: 1,
        rowLabel: "A",
      });

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(mockUser, VALID_ID, expect.anything());
    });

    it("propagates ForbiddenException from the ownership check without creating an area", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(service.createArea(mockUser, baseDto)).rejects.toThrow(
        ForbiddenException
      );
      expect(mockAreaModel.create).not.toHaveBeenCalled();
    });

    it("should throw if event is ended", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.ENDED })
      );

      await expect(service.createArea(mockUser, baseDto)).rejects.toThrow(
        ConflictException
      );
    });

    it("should throw if event not found in ensureEventModifiable", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(mockEventFindOne(null));

      await expect(
        service.createArea(mockUser, {
          ...baseDto,
          seatCount: 1,
          rowLabel: "A",
        })
      ).rejects.toThrow(
        new NotFoundException("Event not found or has been deleted")
      );
    });

    it("should auto generate seats from seatCount and rowLabel", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: new Types.ObjectId(VALID_ZONE_ID),
        currentTotalSeats: 3,
      });

      const createdArea = areaSource({
        seats: ["A1", "A2", "A3"],
        seatCount: 3,
        zoneId: new Types.ObjectId(VALID_ZONE_ID),
      });
      mockAreaModel.create.mockResolvedValueOnce([createdArea]);

      const result = await service.createArea(mockUser, {
        ...baseDto,
        seatCount: 3,
        rowLabel: "A",
      });

      expect(result.seats).toEqual(["A1", "A2", "A3"]);
      expect(result.seatCount).toBe(3);
    });

    it("should use provided seats array over generating", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: new Types.ObjectId(VALID_ZONE_ID),
        currentTotalSeats: 2,
      });

      const createdArea = areaSource({
        seats: ["X1", "X2"],
        seatCount: 2,
      });
      mockAreaModel.create.mockResolvedValueOnce([createdArea]);

      const result = await service.createArea(mockUser, {
        ...baseDto,
        seats: ["X1", "X2"],
      });

      expect(result.seats).toEqual(["X1", "X2"]);
    });

    it("should throw if total seats exceed zone capacity", async () => {
      mockZoneModel.findOne
        .mockReturnValueOnce(
          mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
        )
        .mockReturnValueOnce({
          select: () => ({
            lean: () => ({
              session: jest
                .fn()
                .mockResolvedValue({ capacity: 4, currentTotalSeats: 2 }),
            }),
          }),
        });

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.createArea(mockUser, {
          ...baseDto,
          seatCount: 3,
          rowLabel: "A",
        })
      ).rejects.toThrow(ConflictException);
    });

    it("should throw if zone not found in capacity increment fallback", async () => {
      mockZoneModel.findOne
        .mockReturnValueOnce(
          mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
        )
        .mockReturnValueOnce({
          select: () => ({
            lean: () => ({
              session: jest.fn().mockResolvedValue(null),
            }),
          }),
        });

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce(null);

      await expect(
        service.createArea(mockUser, {
          ...baseDto,
          seatCount: 3,
          rowLabel: "A",
        })
      ).rejects.toThrow(
        new NotFoundException("Zone not found or has been deleted")
      );
    });

    it("should throw duplicate key error (11000)", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: new Types.ObjectId(VALID_ZONE_ID),
        currentTotalSeats: 0,
      });

      const dupError: any = new Error("duplicate key");
      dupError.code = 11000;
      dupError.keyPattern = { zoneId: 1, name: 1 };
      mockAreaModel.create.mockRejectedValueOnce(dupError);

      await expect(
        service.createArea(mockUser, {
          ...baseDto,
          seatCount: 1,
          rowLabel: "Z",
        })
      ).rejects.toThrow(ConflictException);
    });

    it("should re-throw non-duplicate errors from create", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: new Types.ObjectId(VALID_ZONE_ID),
        currentTotalSeats: 0,
      });

      const genericError = new Error("DB timeout");
      mockAreaModel.create.mockRejectedValueOnce(genericError);

      await expect(
        service.createArea(mockUser, {
          ...baseDto,
          seatCount: 1,
          rowLabel: "Z",
        })
      ).rejects.toThrow("DB timeout");
    });

    it("should handle area creation without seats or seatCount", async () => {
      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: VALID_ID, hasSeating: true })
      );

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      const createdArea = areaSource({
        seats: [],
        seatCount: 0,
        zoneId: new Types.ObjectId(VALID_ZONE_ID),
      });
      mockAreaModel.create.mockResolvedValueOnce([createdArea]);

      const result = await service.createArea(mockUser, baseDto);

      expect(result.seatCount).toBe(0);
      expect(result.seats).toEqual([]);
    });
  });

  // ================= getAreaById =================
  describe("getAreaById", () => {
    it("should throw if invalid id", async () => {
      await expect(service.getAreaById(INVALID_ID)).rejects.toThrow(
        BadRequestException
      );
    });

    it("should return cached area", async () => {
      const cachedArea = { _id: VALID_ID };

      mockRedisService.client.get.mockResolvedValueOnce(
        JSON.stringify(cachedArea)
      );

      const result = await service.getAreaById(VALID_ID);

      expect(result).toEqual(cachedArea);
    });

    it("should fetch from DB if cache miss", async () => {
      const area = areaSource();

      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.findOne.mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue(area),
        }),
      });

      const result = await service.getAreaById(VALID_ID);

      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_ID,
          eventId: VALID_ID,
          zoneId: VALID_ZONE_ID,
        })
      );
      expect(mockRedisService.client.set).toHaveBeenCalled();
    });

    it("should handle redis cache get error gracefully", async () => {
      const area = areaSource();

      mockRedisService.client.get.mockRejectedValueOnce(
        new Error("Redis down")
      );

      mockAreaModel.findOne.mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue(area),
        }),
      });

      const result = await service.getAreaById(VALID_ID);

      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_ID,
          eventId: VALID_ID,
          zoneId: VALID_ZONE_ID,
        })
      );
    });

    it("should throw if area not found in DB", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.findOne.mockReturnValue({
        lean: () => ({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.getAreaById(VALID_ID)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  // ================= getAllAreas =================
  describe("getAllAreas", () => {
    it("should return cached result", async () => {
      const cached = { items: [{ name: "VIP" }], meta: { totalItems: 1 } };

      mockRedisService.client.get.mockResolvedValueOnce(JSON.stringify(cached));

      const result = await service.getAllAreas({} as any);

      expect(result).toEqual(cached);
    });

    it("should fetch paginated areas", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      const areas = [areaSource({ name: "VIP" })];

      mockAreaModel.aggregate.mockResolvedValueOnce([
        {
          data: areas,
          count: [{ total: 1 }],
        },
      ]);

      const result = await service.getAllAreas({ page: 1, limit: 10 } as any);

      expect(result.items.length).toBe(1);
      expect(result.meta.totalPages).toBe(1);
    });

    it("should throw if zoneId is invalid", async () => {
      await expect(
        service.getAllAreas({ zoneId: INVALID_ID } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should filter by search keyword over name and description", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([
        {
          data: [areaSource({ name: "VIP", description: "Very important" })],
          count: [{ total: 1 }],
        },
      ]);

      const result = await service.getAllAreas({
        search: "VIP",
        page: 1,
        limit: 10,
      } as any);

      expect(result.items).toHaveLength(1);
      const matchArg = mockAreaModel.aggregate.mock.calls[0][0];
      const $match = matchArg.find((stage: any) => stage.$match);
      expect($match.$match.$or).toBeDefined();
      expect($match.$match.$or).toHaveLength(2);
    });

    it("should filter by name prefix", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([
        { data: [areaSource({ name: "VIP AREA" })], count: [{ total: 1 }] },
      ]);

      const result = await service.getAllAreas({
        name: "vip",
        page: 1,
        limit: 10,
      } as any);

      expect(result.items).toHaveLength(1);
      const matchArg = mockAreaModel.aggregate.mock.calls[0][0];
      const $match = matchArg.find((stage: any) => stage.$match);
      expect($match.$match.name).toBeDefined();
    });

    it("should filter by hasSeating = true", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([
        { data: [areaSource({ name: "VIP" })], count: [{ total: 1 }] },
      ]);

      await service.getAllAreas({ hasSeating: true } as any);

      const matchArg = mockAreaModel.aggregate.mock.calls[0][0];
      const $match = matchArg.find((stage: any) => stage.$match);
      expect($match.$match.seatCount).toEqual({ $gt: 0 });
    });

    it("should filter by hasSeating = false", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([
        { data: [], count: [{ total: 0 }] },
      ]);

      await service.getAllAreas({ hasSeating: false } as any);

      const matchArg = mockAreaModel.aggregate.mock.calls[0][0];
      const $match = matchArg.find((stage: any) => stage.$match);
      expect($match.$match.seatCount).toBe(0);
    });

    it("should default sortBy to createdAt when not provided", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([
        { data: [], count: [{ total: 0 }] },
      ]);

      await service.getAllAreas({} as any);

      const matchArg = mockAreaModel.aggregate.mock.calls[0][0];
      const $sort = matchArg.find((stage: any) => stage.$sort);
      expect($sort.$sort.createdAt).toBeDefined();
    });

    it("should handle empty count array", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([{ data: [], count: [] }]);

      const result = await service.getAllAreas({ page: 1, limit: 10 } as any);

      expect(result.meta.totalItems).toBe(0);
      expect(result.meta.totalPages).toBe(0);
    });

    it("should handle cache set errors gracefully", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);
      mockRedisService.client.set.mockRejectedValueOnce(
        new Error("Redis down")
      );
      mockRedisService.client.sAdd.mockRejectedValueOnce(
        new Error("Redis down")
      );
      mockRedisService.client.expire.mockRejectedValueOnce(
        new Error("Redis down")
      );

      mockAreaModel.aggregate.mockResolvedValueOnce([
        { data: [areaSource({ name: "VIP" })], count: [{ total: 1 }] },
      ]);

      const result = await service.getAllAreas({ page: 1, limit: 10 } as any);

      expect(result.items).toHaveLength(1);
    });

    it("should respect sortOrder asc", async () => {
      mockRedisService.client.get.mockResolvedValueOnce(null);

      mockAreaModel.aggregate.mockResolvedValueOnce([
        { data: [], count: [{ total: 0 }] },
      ]);

      await service.getAllAreas({ sortOrder: "asc" } as any);

      const matchArg = mockAreaModel.aggregate.mock.calls[0][0];
      const $sort = matchArg.find((stage: any) => stage.$sort);
      expect($sort.$sort.createdAt).toBe(1);
    });
  });

  // ================= updateArea =================
  describe("updateArea", () => {
    const zoneObjectId = new Types.ObjectId(VALID_ZONE_ID);
    const idObjectId = new Types.ObjectId(VALID_ID);

    const currentArea = {
      _id: idObjectId,
      zoneId: zoneObjectId,
      eventId: new Types.ObjectId(VALID_ID),
      seatCount: 2,
      seats: ["A1", "A2"],
      rowLabel: "A",
      isDeleted: false,
    };

    const targetZone = {
      _id: zoneObjectId,
      eventId: new Types.ObjectId(VALID_ID),
      hasSeating: true,
    };

    const updatedArea = areaSource({
      _id: idObjectId,
      eventId: currentArea.eventId,
      zoneId: zoneObjectId,
      name: "PREMIUM",
      seatCount: 2,
      seats: ["A1", "A2"],
    });

    it("should throw if invalid id", async () => {
      await expect(
        service.updateArea(mockUser, INVALID_ID, {} as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if invalid zoneId", async () => {
      await expect(
        service.updateArea(mockUser, VALID_ID, {
          zoneId: INVALID_ID,
        } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if seatCount <= 0", async () => {
      await expect(
        service.updateArea(mockUser, VALID_ID, { seatCount: 0 } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if area not found", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.updateArea(mockUser, VALID_ID, { name: "premium" } as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw if zone not found", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(null),
          }),
        }),
      }));

      await expect(
        service.updateArea(mockUser, VALID_ID, {} as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("should throw if zone has no seating", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest
              .fn()
              .mockResolvedValue({ ...targetZone, hasSeating: false }),
          }),
        }),
      }));

      await expect(
        service.updateArea(mockUser, VALID_ID, {} as any)
      ).rejects.toThrow(ConflictException);
    });

    it("should throw if event is ended", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(targetZone),
          }),
        }),
      }));

      mockEventModel.findOne.mockReturnValueOnce({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.ENDED }),
          }),
        }),
      });

      await expect(
        service.updateArea(mockUser, VALID_ID, {} as any)
      ).rejects.toThrow(ConflictException);
    });

    it("should throw when seatCount provided without rowLabel or seats", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue({
          ...currentArea,
          rowLabel: undefined,
          seats: [],
        }),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(targetZone),
          }),
        }),
      }));

      mockEventModel.findOne.mockReturnValueOnce({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.DRAFT }),
          }),
        }),
      });

      await expect(
        service.updateArea(mockUser, VALID_ID, { seatCount: 5 } as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should generate seats when seatCount provided with rowLabel", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue({
          ...currentArea,
          rowLabel: undefined,
          seats: [],
        }),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(targetZone),
          }),
        }),
      }));

      mockEventModel.findOne.mockReturnValueOnce({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.DRAFT }),
          }),
        }),
      });

      mockBookingModel.countDocuments.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(0),
      });

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: zoneObjectId,
        currentTotalSeats: 5,
      });

      const updated = areaSource({
        _id: idObjectId,
        eventId: currentArea.eventId,
        zoneId: zoneObjectId,
        seatCount: 3,
        seats: ["B1", "B2", "B3"],
      });
      mockAreaModel.findOneAndUpdate.mockResolvedValue(updated);

      const result = await service.updateArea(mockUser, VALID_ID, {
        seatCount: 3,
        rowLabel: "B",
      } as any);

      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_ID,
          seatCount: 3,
          seats: ["B1", "B2", "B3"],
        })
      );
    });

    it("should update successfully with name and description", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(targetZone),
          }),
        }),
      }));

      mockEventModel.findOne.mockReturnValueOnce({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.DRAFT }),
          }),
        }),
      });

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: zoneObjectId,
        currentTotalSeats: 2,
      });

      mockAreaModel.findOneAndUpdate.mockResolvedValue(updatedArea);

      const result = await service.updateArea(mockUser, VALID_ID, {
        name: "premium",
        description: "Updated desc",
      } as any);

      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_ID,
          name: "PREMIUM",
          zoneId: VALID_ZONE_ID,
        })
      );
      expect(mockRedisService.client.del).toHaveBeenCalled();
    });

    it("checks ownership of the area's current event", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });
      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(targetZone),
          }),
        }),
      }));
      mockEventModel.findOne.mockReturnValueOnce({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.DRAFT }),
          }),
        }),
      });
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: zoneObjectId,
        currentTotalSeats: 2,
      });
      mockAreaModel.findOneAndUpdate.mockResolvedValue(updatedArea);

      await service.updateArea(mockUser, VALID_ID, { name: "premium" } as any);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(
        mockUser,
        currentArea.eventId.toString(),
        expect.anything()
      );
    });

    it("propagates ForbiddenException from the ownership check without updating", async () => {
      const { ForbiddenException } = require("@nestjs/common");
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.updateArea(mockUser, VALID_ID, { name: "premium" } as any)
      ).rejects.toThrow(ForbiddenException);
      expect(mockAreaModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects moving an area to a zone in a different event", async () => {
      const newZoneId = "64c1f2e1e1e1e1e1e1e1e1e3";
      const newZoneObjectId = new Types.ObjectId(newZoneId);
      const newTargetZone = {
        _id: newZoneObjectId,
        eventId: new Types.ObjectId("64c1f2e1e1e1e1e1e1e1e1e4"),
        hasSeating: true,
      };

      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(newTargetZone),
          }),
        }),
      }));

      await expect(
        service.updateArea(mockUser, VALID_ID, {
          zoneId: newZoneId,
          name: "moved",
        } as any)
      ).rejects.toThrow(ConflictException);

      expect(mockAreaModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it("should handle moving zone within the same event", async () => {
      const newZoneId = "64c1f2e1e1e1e1e1e1e1e1e3";
      const newZoneObjectId = new Types.ObjectId(newZoneId);
      const newTargetZone = {
        _id: newZoneObjectId,
        eventId: currentArea.eventId,
        hasSeating: true,
      };

      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(newTargetZone),
          }),
        }),
      }));

      mockEventModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.DRAFT }),
          }),
        }),
      }));

      mockBookingModel.countDocuments.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(0),
      });

      mockZoneModel.updateOne.mockResolvedValue({
        matchedCount: 1,
        modifiedCount: 1,
      });
      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: newZoneObjectId,
      });

      mockAreaModel.findOneAndUpdate.mockResolvedValue(
        areaSource({
          _id: idObjectId,
          eventId: newTargetZone.eventId,
          zoneId: newZoneObjectId,
          name: "MOVED",
        })
      );

      const result = await service.updateArea(mockUser, VALID_ID, {
        zoneId: newZoneId,
        name: "moved",
      } as any);

      expect(result.zoneId).toEqual(newZoneId);
      expect(mockZoneModel.updateOne).toHaveBeenCalledTimes(1);
      expect(mockZoneModel.findOneAndUpdate).toHaveBeenCalledTimes(1);
    });

    it("should handle duplicate key error (11000)", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(currentArea),
      });

      mockZoneModel.findOne.mockImplementation(() => ({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue(targetZone),
          }),
        }),
      }));

      mockEventModel.findOne.mockReturnValueOnce({
        select: () => ({
          lean: () => ({
            session: jest.fn().mockResolvedValue({ status: EventStatus.DRAFT }),
          }),
        }),
      });

      mockZoneModel.findOneAndUpdate.mockResolvedValueOnce({
        _id: zoneObjectId,
        currentTotalSeats: 2,
      });

      const dupError: any = new Error("duplicate key");
      dupError.code = 11000;
      dupError.keyPattern = { zoneId: 1, name: 1 };
      mockAreaModel.findOneAndUpdate.mockRejectedValue(dupError);

      await expect(
        service.updateArea(mockUser, VALID_ID, {
          name: "duplicate",
        } as any)
      ).rejects.toThrow(ConflictException);
    });
  });

  // ================= softDeleteArea =================
  describe("softDeleteArea", () => {
    it("should throw if invalid id", async () => {
      await expect(
        service.softDeleteArea(mockUser, INVALID_ID, { isDeleted: true })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw if area not found (first lookup)", async () => {
      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(
        service.softDeleteArea(mockUser, VALID_ID, { isDeleted: true })
      ).rejects.toThrow(NotFoundException);
    });

    it("should soft delete area with isDeleted: true", async () => {
      const area = {
        _id: new Types.ObjectId(VALID_ID),
        isDeleted: true,
        zoneId: new Types.ObjectId(VALID_ZONE_ID),
        eventId: new Types.ObjectId(VALID_ID),
        seatCount: 2,
      };

      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            ...area,
            _id: new Types.ObjectId(VALID_ID),
          }),
        }),
      });

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockBookingModel.countDocuments.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(0),
      });

      mockAreaModel.findOneAndUpdate.mockResolvedValue(area);

      mockZoneModel.updateOne.mockResolvedValue({
        matchedCount: 1,
        modifiedCount: 1,
      });

      const result = await service.softDeleteArea(mockUser, VALID_ID, {
        isDeleted: true,
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_ID,
          eventId: VALID_ID,
          zoneId: VALID_ZONE_ID,
          seatCount: 2,
        })
      );
      expect(mockRedisService.client.del).toHaveBeenCalled();
    });

    it("should restore area with isDeleted: false", async () => {
      const area = {
        _id: new Types.ObjectId(VALID_ID),
        isDeleted: false,
        zoneId: new Types.ObjectId(VALID_ZONE_ID),
        eventId: new Types.ObjectId(VALID_ID),
        seatCount: 2,
      };

      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            ...area,
            _id: new Types.ObjectId(VALID_ID),
          }),
        }),
      });

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockZoneModel.findOne.mockReturnValueOnce(
        mockFindOneChain({ eventId: area.eventId, hasSeating: true })
      );

      await mockBookingModel.countDocuments;

      mockAreaModel.findOneAndUpdate.mockResolvedValue(area);

      mockZoneModel.findOneAndUpdate.mockResolvedValue({});

      const result = await service.softDeleteArea(mockUser, VALID_ID, {
        isDeleted: false,
      });

      expect(result).toEqual(
        expect.objectContaining({
          id: VALID_ID,
          eventId: VALID_ID,
          zoneId: VALID_ZONE_ID,
          seatCount: 2,
        })
      );
    });

    it("should throw if active bookings exist", async () => {
      const areaDoc = {
        _id: new Types.ObjectId(VALID_ID),
        isDeleted: false,
        zoneId: new Types.ObjectId(VALID_ZONE_ID),
        eventId: new Types.ObjectId(VALID_ID),
        seatCount: 2,
      };

      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(areaDoc),
        }),
      });

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockBookingModel.countDocuments.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(3),
      });

      await expect(
        service.softDeleteArea(mockUser, VALID_ID, { isDeleted: true })
      ).rejects.toThrow(ConflictException);
    });

    it("should throw if area not found (second lookup)", async () => {
      const areaDoc = {
        _id: new Types.ObjectId(VALID_ID),
        isDeleted: false,
        zoneId: new Types.ObjectId(VALID_ZONE_ID),
        eventId: new Types.ObjectId(VALID_ID),
        seatCount: 2,
      };

      mockAreaModel.findOne.mockReturnValueOnce({
        session: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue(areaDoc),
        }),
      });

      mockEventModel.findOne.mockReturnValueOnce(
        mockEventFindOne({ status: EventStatus.DRAFT })
      );

      mockBookingModel.countDocuments.mockReturnValueOnce({
        session: jest.fn().mockResolvedValue(0),
      });

      mockAreaModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.softDeleteArea(mockUser, VALID_ID, { isDeleted: true })
      ).rejects.toThrow(ConflictException);
    });
  });
});
