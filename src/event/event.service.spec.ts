import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { Types } from "mongoose";
import { EventService } from "./event.service";
import { EventOwnershipService } from "./event-ownership.service";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Booking } from "@src/schemas/booking.schema";
import { User } from "@src/schemas/user.schema";
import { AuditService } from "@src/audit/audit.service";
import { EventCacheService } from "./infrastructure/cache/event-cache.service";
import { EventRepository } from "./infrastructure/persistence/event.repository";
import { EventPresenter } from "./presenters/event.presenter";
import { EventPublishPolicy } from "./domain/policies/event-publish.policy";
import { EventTimeSlotPolicy } from "./domain/policies/event-time-slot.policy";
import { EventCommandService } from "./application/event-command.service";
import { EventLifecycleService } from "./application/event-lifecycle.service";
import { EventMemberService } from "./application/event-member.service";
import { EventQueryService } from "./application/event-query.service";
import { QueueService } from "@src/queue/queue.service";
import { EventCancellationJobRepository } from "./infrastructure/persistence/event-cancellation-job.repository";
import { EventCancellationPresenter } from "./presenters/event-cancellation.presenter";
import { EventCancellationJobStatus } from "@src/schemas/event-cancellation-job.schema";

describe("EventService", () => {
  let service: EventService;

  const eventId = new Types.ObjectId().toString();
  const adminUser = { userId: new Types.ObjectId().toString(), role: "admin" };
  const normalUser = { userId: new Types.ObjectId().toString(), role: "user" };

  const createSessionMock = () => ({
    withTransaction: jest.fn(async (cb: () => Promise<void>) => cb()),
    endSession: jest.fn().mockResolvedValue(undefined),
  });

  const validZone = (overrides: Record<string, any> = {}) => ({
    _id: new Types.ObjectId(),
    name: "General",
    capacity: 10,
    price: 100,
    hasSeating: false,
    ...overrides,
  });

  const mockZonesLean = (zones: any[]) => {
    zoneModel.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue(zones),
    });
  };

  const mockAreasLean = (areas: any[]) => {
    areaModel.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue(areas),
    });
  };

  let eventModel: any;
  let zoneModel: any;
  let areaModel: any;
  let bookingModel: any;
  let userModel: any;
  let mockBookingService: any;
  let mockCacheManager: any;
  let mockRedisClient: any;
  let mockEventOwnershipService: any;
  let mockAuditService: any;
  let mockQueueService: any;
  let mockCancellationJobRepository: any;
  let countDocumentsResult: (count: number) => any;

  beforeEach(async () => {
    eventModel = jest.fn().mockImplementation((data: any) => ({
      ...data,
      _id: new Types.ObjectId(),
      save: jest.fn().mockResolvedValue({ ...data, _id: new Types.ObjectId() }),
    }));

    eventModel.find = jest.fn();
    eventModel.countDocuments = jest.fn();
    eventModel.findOne = jest.fn();
    eventModel.findByIdAndUpdate = jest.fn();
    eventModel.findOneAndUpdate = jest.fn();
    eventModel.findById = jest.fn();
    eventModel.db = {
      startSession: jest.fn().mockResolvedValue(createSessionMock()),
    };

    zoneModel = {
      aggregate: jest.fn(),
      updateMany: jest.fn(),
      find: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    };

    areaModel = {
      updateMany: jest.fn(),
      find: jest
        .fn()
        .mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    };

    const makeDefaultBatchChain = () => ({
      select: jest.fn().mockReturnThis(),
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });

    // Supports both call styles used across the codebase: a direct
    // `await countDocuments(filter)` (e.g. assertRemovedSlotsHaveNoActiveBookings)
    // and the session-scoped `countDocuments(filter).session(session)`
    // (deleteEvent's PRE-9 re-check) — the returned value is itself a
    // resolved Promise with an extra `.session()` method attached, so
    // awaiting it directly or chaining `.session()` both resolve to `count`.
    countDocumentsResult = (count: number) => {
      const query: any = Promise.resolve(count);
      query.session = jest.fn().mockResolvedValue(count);
      return query;
    };

    bookingModel = {
      find: jest.fn().mockReturnValue(makeDefaultBatchChain()),
      countDocuments: jest.fn().mockReturnValue(countDocumentsResult(0)),
    };

    mockBookingService = {
      adminCancelBooking: jest.fn().mockResolvedValue({ message: "cancelled" }),
    };

    mockCacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    userModel = {
      findById: jest.fn(),
      updateOne: jest.fn().mockResolvedValue({ acknowledged: true }),
    };

    mockEventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn().mockResolvedValue([]),
    };

    mockAuditService = {
      record: jest.fn().mockResolvedValue(undefined),
    };

    mockQueueService = {
      addJob: jest.fn().mockResolvedValue(undefined),
    };

    mockCancellationJobRepository = {
      create: jest.fn().mockImplementation((input: any) =>
        Promise.resolve({
          _id: input.id,
          eventId: input.eventId,
          initiatedBy: input.initiatedBy,
          reason: input.reason,
          status: EventCancellationJobStatus.PENDING,
          totalBookings: input.totalBookings,
          processedCount: 0,
          succeededCount: 0,
          failedCount: 0,
          skippedCount: 0,
          failures: [],
        })
      ),
      loadById: jest.fn(),
      loadLatestForEvent: jest.fn(),
      markProcessing: jest.fn(),
      applyBatchProgress: jest.fn(),
      markCompleted: jest.fn(),
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
        { provide: getModelToken(Zone.name), useValue: zoneModel },
        { provide: getModelToken(Area.name), useValue: areaModel },
        { provide: getModelToken(Booking.name), useValue: bookingModel },
        { provide: getModelToken(User.name), useValue: userModel },
        {
          provide: EventOwnershipService,
          useValue: mockEventOwnershipService,
        },
        {
          provide: AuditService,
          useValue: mockAuditService,
        },
        {
          provide:
            require("@src/report/infrastructure/cache/report-cache.service")
              .ReportCacheService,
          useValue: { invalidateAll: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: require("@nestjs/cache-manager").CACHE_MANAGER,
          useValue: mockCacheManager,
        },
        {
          provide: require("@src/booking/booking.service").BookingService,
          useValue: mockBookingService,
        },
        {
          provide: require("@src/redis/redis.service").RedisService,
          useValue: {
            client: {
              get: jest.fn().mockResolvedValue(null),
              set: jest.fn().mockResolvedValue("OK"),
              sAdd: jest.fn().mockResolvedValue(1),
              sMembers: jest.fn().mockResolvedValue([]),
              expire: jest.fn().mockResolvedValue(1),
              del: jest.fn().mockResolvedValue(0),
            },
          },
        },
        { provide: QueueService, useValue: mockQueueService },
        {
          provide: EventCancellationJobRepository,
          useValue: mockCancellationJobRepository,
        },
        EventCancellationPresenter,
      ],
    }).compile();

    service = module.get<EventService>(EventService);
    mockRedisClient = module.get(
      require("@src/redis/redis.service").RedisService
    ).client;
  });

  describe("getEvents", () => {
    it("returns only non-deleted events for non-admin users", async () => {
      const events = [{ _id: eventId, title: "Concert" }];

      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue(events),
                }),
              }),
            }),
          }),
        }),
      });

      eventModel.countDocuments.mockResolvedValue(1);

      const result = await service.getEvents(
        { page: 1, limit: 10 } as any,
        normalUser as any
      );

      expect(result.items).toEqual([
        expect.objectContaining({ id: eventId, title: "Concert" }),
      ]);
      expect(result.meta.totalItems).toBe(1);
      expect(eventModel.countDocuments).toHaveBeenCalledWith({
        isDeleted: false,
      });
    });

    it("applies status filter when provided", async () => {
      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });
      eventModel.countDocuments.mockResolvedValue(0);

      await service.getEvents(
        { page: 1, limit: 10, status: "active" } as any,
        normalUser as any
      );

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({ isDeleted: false, status: "active" })
      );
    });

    it("does not include status filter when status not provided", async () => {
      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });
      eventModel.countDocuments.mockResolvedValue(0);

      await service.getEvents({ page: 1, limit: 10 } as any, normalUser as any);

      const findFilter = eventModel.find.mock.calls[0][0];
      expect(findFilter).not.toHaveProperty("status");
    });

    it("filters by isDeleted:false explicitly for admin when isDeleted not provided", async () => {
      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });
      eventModel.countDocuments.mockResolvedValue(0);

      await service.getEvents({ page: 1, limit: 10 } as any, adminUser as any);

      const findFilter = eventModel.find.mock.calls[0][0];
      expect(findFilter).not.toHaveProperty("isDeleted");
    });

    it("supports admin isDeleted filter", async () => {
      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });

      eventModel.countDocuments.mockResolvedValue(0);

      await service.getEvents(
        { page: 1, limit: 10, isDeleted: true } as any,
        adminUser as any
      );

      expect(eventModel.countDocuments).toHaveBeenCalledWith({
        isDeleted: true,
      });
    });

    it("applies search and dynamic sorting", async () => {
      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });
      eventModel.countDocuments.mockResolvedValue(0);

      await service.getEvents(
        {
          page: 1,
          limit: 10,
          search: "music",
          sortBy: "startDate",
          sortOrder: "asc",
        } as any,
        adminUser as any
      );

      expect(eventModel.find).toHaveBeenCalledWith(
        expect.objectContaining({
          $or: expect.any(Array),
        })
      );

      const sortCall = eventModel.find.mock.results[0].value.sort;
      expect(sortCall).toHaveBeenCalledWith({ startDate: 1 });
    });
  });

  describe("getEventZones", () => {
    it("throws BadRequestException for invalid event id", async () => {
      await expect(
        service.getEventZones("invalid-id", normalUser as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when event does not exist", async () => {
      eventModel.findOne.mockResolvedValue(null);

      await expect(
        service.getEventZones(eventId, normalUser as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("returns zones with limited projection for non-admin", async () => {
      eventModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
      });
      zoneModel.aggregate.mockResolvedValue([{ name: "VIP", hasAreas: true }]);

      const result = await service.getEventZones(eventId, normalUser as any);

      expect(result).toEqual([{ name: "VIP", hasAreas: true }]);
      expect(zoneModel.aggregate).toHaveBeenCalledTimes(1);

      const pipeline = zoneModel.aggregate.mock.calls[0][0];
      expect(pipeline).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            $match: expect.objectContaining({ isDeleted: false }),
          }),
          expect.objectContaining({
            $project: expect.objectContaining({
              name: 1,
              price: 1,
              hasSeating: 1,
              hasAreas: 1,
              areas: 1,
            }),
          }),
        ])
      );
    });

    it("returns full zone data for admin without user projection", async () => {
      eventModel.findOne.mockResolvedValue({
        _id: new Types.ObjectId(eventId),
      });
      zoneModel.aggregate.mockResolvedValue([
        { name: "VIP", areas: [{ _id: "a1" }] },
      ]);

      const result = await service.getEventZones(eventId, adminUser as any);

      expect(result).toEqual([{ name: "VIP", areas: [{ _id: "a1" }] }]);
      const pipeline = zoneModel.aggregate.mock.calls[0][0];
      const hasProjectStage = pipeline.some((stage: any) => stage.$project);
      expect(hasProjectStage).toBe(false);
    });
  });

  describe("getActiveEventById", () => {
    it("returns active event", async () => {
      const event = { _id: eventId, isDeleted: false, title: "Concert" };
      eventModel.findOne.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(event),
        }),
      });

      const result = await service.getActiveEventById(eventId);
      expect(result).toEqual(
        expect.objectContaining({ id: eventId, title: "Concert" })
      );
    });

    it("throws NotFoundException when active event is missing", async () => {
      eventModel.findOne.mockReturnValue({
        populate: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.getActiveEventById(eventId)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("getDeletedEvents", () => {
    it("returns deleted events list", async () => {
      const deleted = [{ _id: eventId, isDeleted: true }];
      eventModel.find.mockReturnValue({
        exec: jest.fn().mockResolvedValue(deleted),
      });

      const result = await service.getDeletedEvents();

      expect(result).toEqual([expect.objectContaining({ id: eventId })]);
      expect(eventModel.find).toHaveBeenCalledWith({ isDeleted: true });
    });
  });

  describe("createEvent", () => {
    it("creates event and sets createdBy", async () => {
      const dto = {
        title: "Event A",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      };

      const result = await service.createEvent(adminUser as any, dto as any);

      expect(result).toBeDefined();
      expect(eventModel).toHaveBeenCalledWith(
        expect.objectContaining({
          createdBy: expect.any(Types.ObjectId),
          title: "Event A",
        })
      );
    });

    it("invalidates list cache keys when sMembers returns values", async () => {
      mockRedisClient.sMembers.mockResolvedValue(["event:list:cache-key-1"]);
      const dto = {
        title: "Event A",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      };

      const result = await service.createEvent(adminUser as any, dto as any);

      expect(result).toBeDefined();
      expect(mockCacheManager.del).toHaveBeenCalledWith(
        "event:list:cache-key-1"
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith("events:list:index:v1");
    });

    it("throws BadRequestException when creating with status=active directly (a brand-new event can never have zones yet)", async () => {
      const dto = {
        title: "Event A",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
        status: EventStatus.ACTIVE,
      };

      await expect(
        service.createEvent(adminUser as any, dto as any)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("updateEvent", () => {
    it("throws NotFoundException when event not found", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.updateEvent(adminUser as any, eventId, { title: "New" } as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("updates event with updatedBy", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: false }),
      });

      eventModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: eventId, title: "New" }),
      });

      const result = await service.updateEvent(adminUser as any, eventId, {
        title: "New",
      } as any);

      expect(result).toEqual(
        expect.objectContaining({ id: eventId, title: "New" })
      );
      expect(eventModel.findByIdAndUpdate).toHaveBeenCalledWith(
        eventId,
        expect.objectContaining({
          title: "New",
          updatedBy: expect.any(Types.ObjectId),
        }),
        { new: true }
      );
    });

    it("throws NotFoundException when findByIdAndUpdate returns null (second check)", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: false }),
      });
      eventModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.updateEvent(adminUser as any, eventId, { title: "New" } as any)
      ).rejects.toThrow(NotFoundException);
    });

    it("delegates ownership check to EventOwnershipService.assertCanManageEvent", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: false }),
      });
      eventModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: eventId, title: "New" }),
      });

      await service.updateEvent(normalUser as any, eventId, {
        title: "New",
      } as any);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(normalUser, eventId);
    });

    it("propagates ForbiddenException from the ownership check without mutating the event", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: false }),
      });
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException(
          "You do not have permission to manage this event"
        )
      );

      await expect(
        service.updateEvent(normalUser as any, eventId, { title: "New" } as any)
      ).rejects.toThrow(ForbiddenException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when trying to change the status of an ended event", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.ENDED,
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-02"),
        }),
      });

      await expect(
        service.updateEvent(adminUser as any, eventId, {
          status: EventStatus.ACTIVE,
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("blocks setting status=active via update when the event has no zones (closes the publish-validation bypass)", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.DRAFT,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-02"),
        }),
      });
      mockZonesLean([]);

      await expect(
        service.updateEvent(adminUser as any, eventId, {
          status: EventStatus.ACTIVE,
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("allows setting status=active via update when inventory is valid", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.DRAFT,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-02"),
        }),
      });
      mockZonesLean([validZone()]);
      eventModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          status: EventStatus.ACTIVE,
        }),
      });

      const result = await service.updateEvent(adminUser as any, eventId, {
        status: EventStatus.ACTIVE,
      } as any);

      expect(result.status).toBe(EventStatus.ACTIVE);
    });

    it("rejects endDate <= startDate on an already-active event even when status is not part of the request", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.ACTIVE,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-05"),
        }),
      });

      await expect(
        service.updateEvent(adminUser as any, eventId, {
          endDate: new Date("2029-12-31"),
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a blank title on an already-active event even when status is not part of the request", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.ACTIVE,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-05"),
        }),
      });

      await expect(
        service.updateEvent(adminUser as any, eventId, {
          title: " ",
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects a blank location on an already-active event even when status is not part of the request", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.ACTIVE,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-05"),
        }),
      });

      await expect(
        service.updateEvent(adminUser as any, eventId, {
          location: " ",
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("rejects shrinking endDate below an existing zone's saleEndDate on an already-active event", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.ACTIVE,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-10"),
        }),
      });
      mockZonesLean([validZone({ saleEndDate: new Date("2030-01-09") })]);

      await expect(
        service.updateEvent(adminUser as any, eventId, {
          endDate: new Date("2030-01-05"),
        } as any)
      ).rejects.toThrow(BadRequestException);
      expect(eventModel.findByIdAndUpdate).not.toHaveBeenCalled();
    });

    it("allows editing an already-active event when the resulting data is still publishable", async () => {
      eventModel.findOne.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          isDeleted: false,
          status: EventStatus.ACTIVE,
          title: "Event A",
          location: "HCM",
          startDate: new Date("2030-01-01"),
          endDate: new Date("2030-01-05"),
        }),
      });
      mockZonesLean([validZone()]);
      eventModel.findByIdAndUpdate.mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: eventId,
          title: "Updated title",
        }),
      });

      const result = await service.updateEvent(adminUser as any, eventId, {
        title: "Updated title",
      } as any);

      expect(result.title).toBe("Updated title");
    });
  });

  describe("publishEvent", () => {
    const draftEvent = () => ({
      _id: eventId,
      isDeleted: false,
      status: EventStatus.DRAFT,
      title: "Event A",
      location: "HCM",
      startDate: new Date("2030-01-01"),
      endDate: new Date("2030-01-02"),
    });

    it("publishes a draft event with valid inventory", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([validZone()]);
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.ACTIVE,
      });

      const result = await service.publishEvent(adminUser as any, eventId);

      expect(result.status).toBe(EventStatus.ACTIVE);
      expect(eventModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: eventId, isDeleted: false, status: EventStatus.DRAFT },
        expect.objectContaining({
          $set: expect.objectContaining({ status: EventStatus.ACTIVE }),
        }),
        { new: true }
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event.publish",
          actorId: adminUser.userId,
          eventId,
        })
      );
    });

    it("delegates ownership check to EventOwnershipService.assertCanManageEvent", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([validZone()]);
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.ACTIVE,
      });

      await service.publishEvent(normalUser as any, eventId);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(normalUser, eventId);
    });

    it("throws NotFoundException when event does not exist", async () => {
      eventModel.findOne.mockResolvedValue(null);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when event is already active", async () => {
      eventModel.findOne.mockResolvedValue({
        ...draftEvent(),
        status: EventStatus.ACTIVE,
      });

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when event is ended or cancelled", async () => {
      eventModel.findOne.mockResolvedValue({
        ...draftEvent(),
        status: EventStatus.CANCELLED,
      });

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when the event has no active zones", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([]);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when total zone capacity is 0", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([validZone({ capacity: 0 })]);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when a zone's sale window is invalid", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([
        validZone({
          saleStartDate: new Date("2030-01-05"),
          saleEndDate: new Date("2030-01-01"),
        }),
      ]);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when a seating zone has no area", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([validZone({ hasSeating: true })]);
      mockAreasLean([]);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when an area has no seats", async () => {
      const zone = validZone({ hasSeating: true });
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([zone]);
      mockAreasLean([
        { _id: new Types.ObjectId(), zoneId: zone._id, name: "A", seats: [] },
      ]);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when an area has duplicate seats", async () => {
      const zone = validZone({ hasSeating: true });
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([zone]);
      mockAreasLean([
        {
          _id: new Types.ObjectId(),
          zoneId: zone._id,
          name: "A",
          seats: ["A1", "A1"],
        },
      ]);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("publishes a seating zone that has valid, unique-seat areas", async () => {
      const zone = validZone({ hasSeating: true });
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([zone]);
      mockAreasLean([
        {
          _id: new Types.ObjectId(),
          zoneId: zone._id,
          name: "A",
          seats: ["A1", "A2"],
        },
      ]);
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.ACTIVE,
      });

      const result = await service.publishEvent(adminUser as any, eventId);
      expect(result.status).toBe(EventStatus.ACTIVE);
    });

    it("throws BadRequestException when the status changed concurrently (findOneAndUpdate race loss)", async () => {
      eventModel.findOne.mockResolvedValue(draftEvent());
      mockZonesLean([validZone()]);
      eventModel.findOneAndUpdate.mockResolvedValue(null);

      await expect(
        service.publishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("unpublishEvent", () => {
    it("moves an active event to inactive", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.INACTIVE,
      });

      const result = await service.unpublishEvent(adminUser as any, eventId);

      expect(result.status).toBe(EventStatus.INACTIVE);
      expect(eventModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: eventId, isDeleted: false, status: EventStatus.ACTIVE },
        expect.objectContaining({
          $set: expect.objectContaining({ status: EventStatus.INACTIVE }),
        }),
        { new: true }
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "event.unpublish", eventId })
      );
    });

    it("throws NotFoundException when the event does not exist", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue(null);
      eventModel.exists = jest.fn().mockResolvedValue(null);

      await expect(
        service.unpublishEvent(adminUser as any, eventId)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when the event is not active", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue(null);
      eventModel.exists = jest.fn().mockResolvedValue({ _id: eventId });

      await expect(
        service.unpublishEvent(adminUser as any, eventId)
      ).rejects.toThrow(BadRequestException);
    });

    it("delegates ownership check to EventOwnershipService.assertCanManageEvent", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.INACTIVE,
      });

      await service.unpublishEvent(normalUser as any, eventId);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(normalUser, eventId);
    });
  });

  describe("endEvent", () => {
    it("ends an active event", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.ENDED,
      });

      const result = await service.endEvent(adminUser as any, eventId);

      expect(result.status).toBe(EventStatus.ENDED);
      expect(eventModel.findOneAndUpdate).toHaveBeenCalledWith(
        {
          _id: eventId,
          isDeleted: false,
          status: { $in: [EventStatus.ACTIVE, EventStatus.INACTIVE] },
        },
        expect.objectContaining({
          $set: expect.objectContaining({ status: EventStatus.ENDED }),
        }),
        { new: true }
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "event.end", eventId })
      );
    });

    it("throws NotFoundException when the event does not exist", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue(null);
      eventModel.exists = jest.fn().mockResolvedValue(null);

      await expect(service.endEvent(adminUser as any, eventId)).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws BadRequestException when the event is draft or already ended/cancelled", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue(null);
      eventModel.exists = jest.fn().mockResolvedValue({ _id: eventId });

      await expect(service.endEvent(adminUser as any, eventId)).rejects.toThrow(
        BadRequestException
      );
    });

    it("delegates ownership check to EventOwnershipService.assertCanManageEvent", async () => {
      eventModel.findOneAndUpdate.mockResolvedValue({
        _id: eventId,
        status: EventStatus.ENDED,
      });

      await service.endEvent(normalUser as any, eventId);

      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(normalUser, eventId);
    });
  });

  describe("getMyManagedEvents", () => {
    it("scopes the query to events the user owns or organizes", async () => {
      const events = [{ _id: eventId, title: "My Event" }];
      const findChain = {
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(events),
      };
      eventModel.find.mockReturnValue(findChain);
      eventModel.countDocuments.mockResolvedValue(1);

      const result = await service.getMyManagedEvents(
        normalUser as any,
        {
          page: 1,
          limit: 10,
        } as any
      );

      expect(result.items).toEqual([
        expect.objectContaining({ id: eventId, title: "My Event" }),
      ]);
      expect(result.meta.totalItems).toBe(1);
      const passedFilter = eventModel.find.mock.calls[0][0];
      expect(passedFilter.isDeleted).toBe(false);
      expect(passedFilter.$and[0].$or).toEqual([
        { createdBy: new Types.ObjectId(normalUser.userId) },
        { organizerIds: new Types.ObjectId(normalUser.userId) },
      ]);
    });
  });

  describe("addOrganizerToEvent", () => {
    const targetUserId = new Types.ObjectId().toString();

    it("adds the target user as organizer and promotes their role from user to organizer", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [] as Types.ObjectId[],
        save: jest.fn().mockResolvedValue(undefined),
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "user",
          isActive: true,
        }),
      });

      await service.addOrganizerToEvent(
        adminUser as any,
        eventId,
        targetUserId
      );

      expect(doc.organizerIds).toHaveLength(1);
      expect(doc.save).toHaveBeenCalled();
      expect(userModel.updateOne).toHaveBeenCalledWith(
        { _id: targetUserId },
        { $set: { role: "organizer" } },
        expect.objectContaining({ session: expect.anything() })
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event.organizer_add",
          actorId: adminUser.userId,
          eventId,
          metadata: { targetUserId },
        })
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `auth:user-state:${targetUserId}`
      );
    });

    it("promotes an existing checkin_staff to organizer so RolesGuard actually admits them", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [] as Types.ObjectId[],
        save: jest.fn().mockResolvedValue(undefined),
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "checkin_staff",
          isActive: true,
        }),
      });

      await service.addOrganizerToEvent(
        adminUser as any,
        eventId,
        targetUserId
      );

      expect(userModel.updateOne).toHaveBeenCalledWith(
        { _id: targetUserId },
        { $set: { role: "organizer" } },
        expect.objectContaining({ session: expect.anything() })
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `auth:user-state:${targetUserId}`
      );
    });

    it("does not change role when target user is already organizer/admin", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [] as Types.ObjectId[],
        save: jest.fn().mockResolvedValue(undefined),
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "organizer",
          isActive: true,
        }),
      });

      await service.addOrganizerToEvent(
        adminUser as any,
        eventId,
        targetUserId
      );

      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when the target already manages the event", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [new Types.ObjectId(targetUserId)],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);

      await expect(
        service.addOrganizerToEvent(adminUser as any, eventId, targetUserId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when target user does not exist", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [] as Types.ObjectId[],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.addOrganizerToEvent(adminUser as any, eventId, targetUserId)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when target user is inactive", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [] as Types.ObjectId[],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "user",
          isActive: false,
        }),
      });

      await expect(
        service.addOrganizerToEvent(adminUser as any, eventId, targetUserId)
      ).rejects.toThrow(BadRequestException);
    });

    it("propagates the ownership check failure before touching the event", async () => {
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.addOrganizerToEvent(normalUser as any, eventId, targetUserId)
      ).rejects.toThrow(ForbiddenException);
      expect(eventModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe("removeOrganizerFromEvent", () => {
    const organizerUserId = new Types.ObjectId().toString();

    it("removes an assigned organizer", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [new Types.ObjectId(organizerUserId)],
        save: jest.fn().mockResolvedValue(undefined),
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);

      await service.removeOrganizerFromEvent(
        adminUser as any,
        eventId,
        organizerUserId
      );

      expect(doc.organizerIds).toHaveLength(0);
      expect(doc.save).toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event.organizer_remove",
          actorId: adminUser.userId,
          eventId,
          metadata: { targetUserId: organizerUserId },
        })
      );
    });

    it("throws BadRequestException when trying to remove the event owner", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(organizerUserId),
        organizerIds: [] as Types.ObjectId[],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);

      await expect(
        service.removeOrganizerFromEvent(
          adminUser as any,
          eventId,
          organizerUserId
        )
      ).rejects.toThrow(BadRequestException);
    });

    it("throws BadRequestException when target is not an organizer of the event", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        organizerIds: [] as Types.ObjectId[],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);

      await expect(
        service.removeOrganizerFromEvent(
          adminUser as any,
          eventId,
          organizerUserId
        )
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when the event does not exist", async () => {
      eventModel.findOne.mockReturnValue(null);

      await expect(
        service.removeOrganizerFromEvent(
          adminUser as any,
          eventId,
          organizerUserId
        )
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getEventStaff", () => {
    it("returns populated staff list after checking ownership", async () => {
      const staffList = [{ _id: new Types.ObjectId(), email: "a@b.com" }];
      eventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ staffIds: staffList }),
      });

      const result = await service.getEventStaff(adminUser as any, eventId);

      expect(result).toEqual([
        expect.objectContaining({
          id: staffList[0]._id.toString(),
          email: staffList[0].email,
        }),
      ]);
      expect(
        mockEventOwnershipService.assertCanManageEvent
      ).toHaveBeenCalledWith(adminUser, eventId);
    });

    it("throws NotFoundException when the event does not exist", async () => {
      eventModel.findOne.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        populate: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.getEventStaff(adminUser as any, eventId)
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates ForbiddenException from the ownership check", async () => {
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.getEventStaff(normalUser as any, eventId)
      ).rejects.toThrow(ForbiddenException);
      expect(eventModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe("addStaffToEvent", () => {
    const targetUserId = new Types.ObjectId().toString();

    it("adds the target user as staff and promotes their role from user to checkin_staff", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        staffIds: [] as Types.ObjectId[],
        save: jest.fn().mockResolvedValue(undefined),
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "user",
          isActive: true,
        }),
      });

      await service.addStaffToEvent(
        adminUser as any,
        eventId,
        targetUserId,
        "Gate A scanner"
      );

      expect(doc.staffIds).toHaveLength(1);
      expect(doc.save).toHaveBeenCalled();
      expect(userModel.updateOne).toHaveBeenCalledWith(
        { _id: targetUserId },
        { $set: { role: "checkin_staff" } },
        expect.objectContaining({ session: expect.anything() })
      );
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event.staff_add",
          actorId: adminUser.userId,
          eventId,
          reason: "Gate A scanner",
          metadata: { targetUserId },
        })
      );
      expect(mockRedisClient.del).toHaveBeenCalledWith(
        `auth:user-state:${targetUserId}`
      );
    });

    it("does not change role when target user is already staff/organizer/admin", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        staffIds: [] as Types.ObjectId[],
        save: jest.fn().mockResolvedValue(undefined),
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "organizer",
          isActive: true,
        }),
      });

      await service.addStaffToEvent(adminUser as any, eventId, targetUserId);

      expect(userModel.updateOne).not.toHaveBeenCalled();
      expect(mockRedisClient.del).not.toHaveBeenCalled();
    });

    it("throws BadRequestException when the target is already staff", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        staffIds: [new Types.ObjectId(targetUserId)],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);

      await expect(
        service.addStaffToEvent(adminUser as any, eventId, targetUserId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when target user does not exist", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        staffIds: [] as Types.ObjectId[],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.addStaffToEvent(adminUser as any, eventId, targetUserId)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when target user is inactive", async () => {
      const doc = {
        _id: eventId,
        createdBy: new Types.ObjectId(adminUser.userId),
        staffIds: [] as Types.ObjectId[],
        session: jest.fn().mockReturnThis(),
      };
      eventModel.findOne.mockReturnValue(doc);
      userModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        session: jest.fn().mockResolvedValue({
          _id: targetUserId,
          role: "user",
          isActive: false,
        }),
      });

      await expect(
        service.addStaffToEvent(adminUser as any, eventId, targetUserId)
      ).rejects.toThrow(BadRequestException);
    });

    it("propagates the ownership check failure before touching the event", async () => {
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.addStaffToEvent(normalUser as any, eventId, targetUserId)
      ).rejects.toThrow(ForbiddenException);
      expect(eventModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe("removeStaffFromEvent", () => {
    const staffUserId = new Types.ObjectId().toString();

    it("removes an assigned staff member", async () => {
      const doc = {
        _id: eventId,
        staffIds: [new Types.ObjectId(staffUserId)],
        save: jest.fn().mockResolvedValue(undefined),
      };
      eventModel.findOne.mockReturnValue(doc);

      await service.removeStaffFromEvent(
        adminUser as any,
        eventId,
        staffUserId
      );

      expect(doc.staffIds).toHaveLength(0);
      expect(doc.save).toHaveBeenCalled();
      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "event.staff_remove",
          actorId: adminUser.userId,
          eventId,
          metadata: { targetUserId: staffUserId },
        })
      );
    });

    it("throws BadRequestException when target is not staff of the event", async () => {
      const doc = {
        _id: eventId,
        staffIds: [] as Types.ObjectId[],
      };
      eventModel.findOne.mockReturnValue(doc);

      await expect(
        service.removeStaffFromEvent(adminUser as any, eventId, staffUserId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when the event does not exist", async () => {
      eventModel.findOne.mockReturnValue(null);

      await expect(
        service.removeStaffFromEvent(adminUser as any, eventId, staffUserId)
      ).rejects.toThrow(NotFoundException);
    });

    it("propagates the ownership check failure before touching the event", async () => {
      mockEventOwnershipService.assertCanManageEvent.mockRejectedValueOnce(
        new ForbiddenException("nope")
      );

      await expect(
        service.removeStaffFromEvent(normalUser as any, eventId, staffUserId)
      ).rejects.toThrow(ForbiddenException);
      expect(eventModel.findOne).not.toHaveBeenCalled();
    });
  });

  describe("deleteEvent", () => {
    it("soft-deletes event and cascades zone/area", async () => {
      const session = createSessionMock();
      eventModel.db.startSession.mockResolvedValue(session);

      const doc = {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        save: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: true }),
      };

      eventModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(doc),
        }),
      });

      zoneModel.updateMany.mockResolvedValue({ acknowledged: true });
      areaModel.updateMany.mockResolvedValue({ acknowledged: true });

      const result = await service.deleteEvent(eventId);

      expect(result).toEqual(expect.objectContaining({ id: eventId }));
      expect(zoneModel.updateMany).toHaveBeenCalledWith(
        { eventId: doc._id, isDeleted: false },
        { $set: { isDeleted: true } },
        { session }
      );
      expect(areaModel.updateMany).toHaveBeenCalledWith(
        { eventId: doc._id, isDeleted: false },
        { $set: { isDeleted: true } },
        { session }
      );
    });

    it("throws NotFoundException when event already deleted or missing", async () => {
      const session = createSessionMock();
      eventModel.db.startSession.mockResolvedValue(session);

      eventModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.deleteEvent(eventId)).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws NotFoundException when deletedEvent is null after transaction", async () => {
      const session = createSessionMock();
      eventModel.db.startSession.mockResolvedValue(session);

      const doc = {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        save: jest.fn().mockResolvedValue(null),
      };

      eventModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(doc),
        }),
      });

      zoneModel.updateMany.mockResolvedValue({ acknowledged: true });
      areaModel.updateMany.mockResolvedValue({ acknowledged: true });

      await expect(service.deleteEvent(eventId)).rejects.toThrow(
        NotFoundException
      );
    });

    // PRE-9 (production-readiness-audit-2026-07-22.md): the active-booking
    // guard MUST be re-checked inside the same transaction/session as the
    // delete writes, not before the transaction opens — otherwise a booking
    // created in the gap is never caught and ends up referencing a deleted
    // event.
    describe("PRE-9 — active-booking re-check inside the transaction", () => {
      it("throws BadRequestException and performs no writes when active bookings are found via the session-scoped check", async () => {
        const session = createSessionMock();
        eventModel.db.startSession.mockResolvedValue(session);

        const doc = {
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          save: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: true }),
        };
        eventModel.findOne.mockReturnValue({
          session: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(doc),
          }),
        });
        bookingModel.countDocuments.mockReturnValueOnce(
          countDocumentsResult(3)
        );

        await expect(service.deleteEvent(eventId)).rejects.toThrow(
          "Cancel all active bookings before deleting this event"
        );

        expect(doc.save).not.toHaveBeenCalled();
        expect(zoneModel.updateMany).not.toHaveBeenCalled();
        expect(areaModel.updateMany).not.toHaveBeenCalled();
      });

      it("checks active bookings using the query's .session() — not a plain pre-transaction read", async () => {
        const session = createSessionMock();
        eventModel.db.startSession.mockResolvedValue(session);

        const doc = {
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          save: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: true }),
        };
        eventModel.findOne.mockReturnValue({
          session: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(doc),
          }),
        });
        const countQuery = countDocumentsResult(0);
        bookingModel.countDocuments.mockReturnValueOnce(countQuery);

        await service.deleteEvent(eventId);

        expect(bookingModel.countDocuments).toHaveBeenCalledWith(
          expect.objectContaining({
            eventId: doc._id,
            status: expect.objectContaining({ $in: expect.any(Array) }),
            isDeleted: false,
          })
        );
        expect(countQuery.session).toHaveBeenCalledWith(session);
      });

      it("every repository call inside the transaction shares the identical session object", async () => {
        const session = createSessionMock();
        eventModel.db.startSession.mockResolvedValue(session);

        const doc = {
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          save: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: true }),
        };
        const findOneSessionCall = jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(doc),
        });
        eventModel.findOne.mockReturnValue({ session: findOneSessionCall });
        const countQuery = countDocumentsResult(0);
        bookingModel.countDocuments.mockReturnValueOnce(countQuery);

        await service.deleteEvent(eventId);

        expect(findOneSessionCall).toHaveBeenCalledWith(session);
        expect(countQuery.session).toHaveBeenCalledWith(session);
        expect(doc.save).toHaveBeenCalledWith({ session });
        expect(zoneModel.updateMany).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          { session }
        );
        expect(areaModel.updateMany).toHaveBeenCalledWith(
          expect.anything(),
          expect.anything(),
          { session }
        );
      });

      it("closes the TOCTOU race: on a transaction retry (e.g. a write conflict against the shared zone document from a concurrent create-booking transaction), the re-run re-checks active bookings against the now-current state", async () => {
        const session = createSessionMock();
        eventModel.db.startSession.mockResolvedValue(session);

        const doc = {
          _id: new Types.ObjectId(eventId),
          isDeleted: false,
          save: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: true }),
        };
        eventModel.findOne.mockReturnValue({
          session: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(doc),
          }),
        });

        // First attempt: no active bookings yet (a stale read that — under
        // the old PRE-9 code, checked once before the transaction — would
        // have let the delete through). Second attempt simulates the
        // MongoDB driver retrying the whole callback after a
        // TransientTransactionError (e.g. a write conflict with a
        // concurrent create-booking transaction that just committed a new
        // booking for this event) — the retry must see the new booking.
        let attempt = 0;
        bookingModel.countDocuments.mockImplementation(() => {
          attempt++;
          return countDocumentsResult(attempt === 1 ? 0 : 1);
        });
        session.withTransaction = jest.fn(async (cb: () => Promise<void>) => {
          await cb();
          await cb();
        });

        await expect(service.deleteEvent(eventId)).rejects.toThrow(
          "Cancel all active bookings before deleting this event"
        );
        expect(attempt).toBe(2);
      });
    });
  });

  describe("restoreEvent", () => {
    it("restores event and cascades zone/area", async () => {
      const session = createSessionMock();
      eventModel.db.startSession.mockResolvedValue(session);

      const doc = {
        _id: new Types.ObjectId(eventId),
        isDeleted: true,
        save: jest.fn().mockResolvedValue({ _id: eventId, isDeleted: false }),
      };

      eventModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(doc),
        }),
      });

      zoneModel.updateMany.mockResolvedValue({ acknowledged: true });
      areaModel.updateMany.mockResolvedValue({ acknowledged: true });

      const result = await service.restoreEvent(eventId);

      expect(result).toEqual(expect.objectContaining({ id: eventId }));
      expect(zoneModel.updateMany).toHaveBeenCalledWith(
        { eventId: doc._id, isDeleted: true },
        { $set: { isDeleted: false } },
        { session }
      );
      expect(areaModel.updateMany).toHaveBeenCalledWith(
        { eventId: doc._id, isDeleted: true },
        { $set: { isDeleted: false } },
        { session }
      );
    });

    it("throws NotFoundException when deleted event is missing", async () => {
      const session = createSessionMock();
      eventModel.db.startSession.mockResolvedValue(session);

      eventModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(null),
        }),
      });

      await expect(service.restoreEvent(eventId)).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws NotFoundException when restoredEvent is null after transaction", async () => {
      const session = createSessionMock();
      eventModel.db.startSession.mockResolvedValue(session);

      const doc = {
        _id: new Types.ObjectId(eventId),
        isDeleted: true,
        save: jest.fn().mockResolvedValue(null),
      };

      eventModel.findOne.mockReturnValue({
        session: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(doc),
        }),
      });

      zoneModel.updateMany.mockResolvedValue({ acknowledged: true });
      areaModel.updateMany.mockResolvedValue({ acknowledged: true });

      await expect(service.restoreEvent(eventId)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("cancelEventWithRefund", () => {
    // NEW#6 (production-readiness-audit-2026-07-22.md): this method MUST
    // return immediately with a queued job handle — it must NOT loop over
    // bookings or call the payment provider on the HTTP request thread.
    // The actual per-booking cancel/refund work is covered by
    // cancel-event-bookings.use-case.spec.ts (partial failure + resume).

    it("throws BadRequestException when eventId is invalid", async () => {
      await expect(
        service.cancelEventWithRefund("bad-id", adminUser.userId)
      ).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException when event not found or already cancelled", async () => {
      eventModel.findOneAndUpdate.mockResolvedValueOnce(null);
      await expect(
        service.cancelEventWithRefund(eventId, adminUser.userId)
      ).rejects.toThrow(NotFoundException);
    });

    it("flips the event to CANCELLED, counts active bookings, creates a job record, and enqueues exactly one job — without calling the payment provider inline", async () => {
      const cancelledEvent = { _id: eventId, status: EventStatus.CANCELLED };
      eventModel.findOneAndUpdate.mockResolvedValueOnce(cancelledEvent);
      bookingModel.countDocuments.mockResolvedValueOnce(2137);

      const result = await service.cancelEventWithRefund(
        eventId,
        adminUser.userId,
        "Weather emergency"
      );

      expect(bookingModel.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: cancelledEvent._id,
          isDeleted: false,
        })
      );
      expect(mockCancellationJobRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          eventId: cancelledEvent._id,
          reason: "Weather emergency",
          totalBookings: 2137,
        })
      );
      expect(mockQueueService.addJob).toHaveBeenCalledTimes(1);
      const [jobData, jobOptions] = mockQueueService.addJob.mock.calls[0];
      expect(jobData.type).toBe("cancel-event-bookings");
      expect(jobData.payload.cancellationJobId).toEqual(expect.any(String));
      expect(jobOptions.jobId).toContain("cancel-event-bookings-");

      expect(result.status).toBe(EventCancellationJobStatus.PENDING);
      expect(result.totalBookings).toBe(2137);
      expect(mockBookingService.adminCancelBooking).not.toHaveBeenCalled();
    });

    it("invalidates the event cache and records an audit entry", async () => {
      const cancelledEvent = { _id: eventId, status: EventStatus.CANCELLED };
      eventModel.findOneAndUpdate.mockResolvedValueOnce(cancelledEvent);

      await service.cancelEventWithRefund(eventId, adminUser.userId);

      expect(mockAuditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: require("@src/schemas/audit-log.schema").AuditAction
            .EVENT_CANCEL,
          actorId: adminUser.userId,
          eventId,
        })
      );
    });

    it("defaults the reason when none is provided", async () => {
      const cancelledEvent = { _id: eventId, status: EventStatus.CANCELLED };
      eventModel.findOneAndUpdate.mockResolvedValueOnce(cancelledEvent);

      await service.cancelEventWithRefund(eventId, adminUser.userId);

      expect(mockCancellationJobRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ reason: "Event cancelled by admin" })
      );
    });
  });

  describe("getCancellationStatus", () => {
    it("throws BadRequestException when eventId is invalid", async () => {
      await expect(service.getCancellationStatus("bad-id")).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws NotFoundException when no cancellation job exists for the event", async () => {
      mockCancellationJobRepository.loadLatestForEvent.mockResolvedValueOnce(
        null
      );
      await expect(service.getCancellationStatus(eventId)).rejects.toThrow(
        NotFoundException
      );
    });

    it("returns the latest job's progress", async () => {
      mockCancellationJobRepository.loadLatestForEvent.mockResolvedValueOnce({
        _id: new Types.ObjectId(),
        eventId: new Types.ObjectId(eventId),
        initiatedBy: new Types.ObjectId(adminUser.userId),
        reason: "Event cancelled by admin",
        status: EventCancellationJobStatus.PROCESSING,
        totalBookings: 500,
        processedCount: 200,
        succeededCount: 195,
        failedCount: 3,
        skippedCount: 2,
        failures: [],
      });

      const result = await service.getCancellationStatus(eventId);

      expect(result.status).toBe(EventCancellationJobStatus.PROCESSING);
      expect(result.processedCount).toBe(200);
      expect(result.totalBookings).toBe(500);
    });
  });

  describe("getCachedEvents", () => {
    const query = { page: 1, limit: 10, status: "active" as const };

    it("returns cached data when available", async () => {
      const cached = { items: [], meta: {} };
      mockCacheManager.get.mockResolvedValueOnce(cached);

      const result = await service.getCachedEvents(query as any);

      expect(result).toEqual(cached);
    });

    it("fetches events and caches them on cache miss", async () => {
      mockCacheManager.get.mockResolvedValueOnce(null);

      eventModel.find.mockReturnValue({
        sort: jest.fn().mockReturnValue({
          skip: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              lean: jest.fn().mockReturnValue({
                populate: jest.fn().mockReturnValue({
                  exec: jest.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });
      eventModel.countDocuments.mockResolvedValue(0);

      const result = await service.getCachedEvents(query as any);

      expect(result).toBeDefined();
      expect(mockCacheManager.set).toHaveBeenCalled();
    });
  });

  describe("getEventById", () => {
    it("returns cached data when available", async () => {
      const cached = { _id: eventId, title: "Cached Event" };
      mockCacheManager.get.mockResolvedValueOnce(cached);

      const result = await service.getEventById(eventId);

      expect(result).toEqual(cached);
      expect(eventModel.findById).not.toHaveBeenCalled();
    });

    it("fetches from DB and caches result on cache miss", async () => {
      mockCacheManager.get.mockResolvedValueOnce(null);
      const event = { _id: eventId, title: "DB Event" };
      eventModel.findById.mockResolvedValueOnce(event);

      const result = await service.getEventById(eventId);

      expect(result).toEqual(
        expect.objectContaining({ id: eventId, title: "DB Event" })
      );
      expect(mockCacheManager.set).toHaveBeenCalledWith(
        `event:details:v1:${eventId}`,
        expect.objectContaining({ id: eventId, title: "DB Event" }),
        60_000
      );
    });

    it("throws NotFoundException when event not found", async () => {
      mockCacheManager.get.mockResolvedValueOnce(null);
      eventModel.findById.mockResolvedValueOnce(null);

      await expect(service.getEventById(eventId)).rejects.toThrow(
        NotFoundException
      );
    });
  });
});
