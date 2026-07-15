import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { EventController } from "./event.controller";
import { EventService } from "./event.service";
import { AuthGuard } from "@nestjs/passport";
import { OptionalJwtAuthGuard } from "@src/guards/optional.guard";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CreateEventDTO } from "./dto/create-event.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { CancelEventDto } from "./dto/cancel-event.dto";
import { AssignOrganizerDto } from "./dto/assign-organizer.dto";

describe("EventController", () => {
  let controller: EventController;
  let eventService: jest.Mocked<EventService>;

  const mockUser: JwtPayload = {
    userId: "admin-id",
    role: "admin",
    iat: 0,
    exp: 0,
  };

  const mockEventId = "507f1f77bcf86cd799439011";
  const eventsResult = {
    items: [{ id: "e1", title: "Concert" }],
    meta: { totalItems: 1 },
  };
  const zonesResult = [{ name: "VIP", price: 100 }];
  const singleEvent = { id: mockEventId, title: "Concert", isDeleted: false };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [EventController],
      providers: [
        {
          provide: EventService,
          useValue: {
            getEvents: jest.fn(),
            getEventZones: jest.fn(),
            getDeletedEvents: jest.fn(),
            getActiveEventById: jest.fn(),
            createEvent: jest.fn(),
            updateEvent: jest.fn(),
            deleteEvent: jest.fn(),
            restoreEvent: jest.fn(),
            cancelEventWithRefund: jest.fn(),
            getMyManagedEvents: jest.fn(),
            addOrganizerToEvent: jest.fn(),
            removeOrganizerFromEvent: jest.fn(),
            getEventStaff: jest.fn(),
            addStaffToEvent: jest.fn(),
            removeStaffFromEvent: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(OptionalJwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<EventController>(EventController);
    eventService = module.get(EventService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("getEvents", () => {
    it("returns paginated events", async () => {
      eventService.getEvents.mockResolvedValue(eventsResult);

      const query: QueryEventDTO = { page: 1, limit: 10 } as QueryEventDTO;
      const result = await controller.getEvents(query, mockUser);

      expect(eventService.getEvents).toHaveBeenCalledWith(query, mockUser);
      expect(result).toEqual(eventsResult);
    });

    it("works without a user (optional auth)", async () => {
      eventService.getEvents.mockResolvedValue(eventsResult);

      const query: QueryEventDTO = { page: 1, limit: 10 } as QueryEventDTO;
      const result = await controller.getEvents(query, undefined);

      expect(eventService.getEvents).toHaveBeenCalledWith(query, undefined);
      expect(result).toEqual(eventsResult);
    });

    it("passes search and filter query params to service", async () => {
      const query: QueryEventDTO = {
        page: 1,
        limit: 20,
        search: "rock",
        sortBy: "startDate",
        sortOrder: "asc",
        status: "active",
      } as QueryEventDTO;
      eventService.getEvents.mockResolvedValue(eventsResult);

      await controller.getEvents(query, mockUser);

      expect(eventService.getEvents).toHaveBeenCalledWith(query, mockUser);
    });
  });

  describe("getEventZones", () => {
    it("returns zones for an event", async () => {
      eventService.getEventZones.mockResolvedValue(zonesResult);

      const result = await controller.getEventZones(mockEventId, mockUser);

      expect(eventService.getEventZones).toHaveBeenCalledWith(
        mockEventId,
        mockUser
      );
      expect(result).toEqual(zonesResult);
    });

    it("works without a user (optional auth)", async () => {
      eventService.getEventZones.mockResolvedValue(zonesResult);

      const result = await controller.getEventZones(mockEventId, undefined);

      expect(eventService.getEventZones).toHaveBeenCalledWith(
        mockEventId,
        undefined
      );
      expect(result).toEqual(zonesResult);
    });
  });

  describe("getDeletedEvents", () => {
    it("returns deleted events", async () => {
      const deleted = [{ id: mockEventId, isDeleted: true }];
      eventService.getDeletedEvents.mockResolvedValue(deleted);

      const result = await controller.getDeletedEvents();

      expect(eventService.getDeletedEvents).toHaveBeenCalled();
      expect(result).toEqual(deleted);
    });
  });

  describe("getEventById", () => {
    it("returns active event by id", async () => {
      eventService.getActiveEventById.mockResolvedValue(singleEvent);

      const result = await controller.getEventById(mockEventId);

      expect(eventService.getActiveEventById).toHaveBeenCalledWith(mockEventId);
      expect(result).toEqual(singleEvent);
    });
  });

  describe("createEvent", () => {
    it("creates an event with current user and DTO", async () => {
      const dto: CreateEventDTO = {
        title: "New Event",
        startDate: new Date("2030-01-01"),
        endDate: new Date("2030-01-02"),
        location: "HCM",
      } as CreateEventDTO;
      const created = { id: "new-id", ...dto };
      eventService.createEvent.mockResolvedValue(created);

      const result = await controller.createEvent(mockUser, dto);

      expect(eventService.createEvent).toHaveBeenCalledWith(mockUser, dto);
      expect(result).toEqual(created);
    });
  });

  describe("updateEvent", () => {
    it("updates an event with current user, id, and DTO", async () => {
      const dto: UpdateEventDTO = { title: "Updated" };
      const updated = { id: mockEventId, title: "Updated" };
      eventService.updateEvent.mockResolvedValue(updated);

      const result = await controller.updateEvent(mockUser, mockEventId, dto);

      expect(eventService.updateEvent).toHaveBeenCalledWith(
        mockUser,
        mockEventId,
        dto
      );
      expect(result).toEqual(updated);
    });
  });

  describe("deleteEvent", () => {
    it("soft-deletes an event by id", async () => {
      const deleted = { id: mockEventId, isDeleted: true };
      eventService.deleteEvent.mockResolvedValue(deleted);

      const result = await controller.deleteEvent(mockEventId);

      expect(eventService.deleteEvent).toHaveBeenCalledWith(mockEventId);
      expect(result).toEqual(deleted);
    });
  });

  describe("restoreEvent", () => {
    it("restores a deleted event by id", async () => {
      const restored = { id: mockEventId, isDeleted: false };
      eventService.restoreEvent.mockResolvedValue(restored);

      const result = await controller.restoreEvent(mockEventId);

      expect(eventService.restoreEvent).toHaveBeenCalledWith(mockEventId);
      expect(result).toEqual(restored);
    });
  });

  describe("cancelEvent", () => {
    it("cancels an event with refund", async () => {
      const dto: CancelEventDto = { reason: "Weather issue" };
      const cancellationResult = { message: "Event cancelled with refund" };
      eventService.cancelEventWithRefund.mockResolvedValue(cancellationResult);

      const result = await controller.cancelEvent(mockEventId, mockUser, dto);

      expect(eventService.cancelEventWithRefund).toHaveBeenCalledWith(
        mockEventId,
        mockUser.userId,
        dto.reason
      );
      expect(result).toEqual(cancellationResult);
    });

    it("cancels an event without a reason", async () => {
      const dto: CancelEventDto = {};
      eventService.cancelEventWithRefund.mockResolvedValue({
        message: "Cancelled",
      });

      await controller.cancelEvent(mockEventId, mockUser, dto);
    });
  });

  describe("getMyManagedEvents", () => {
    it("returns events managed by the current user", async () => {
      eventService.getMyManagedEvents.mockResolvedValue(eventsResult);
      const query: QueryEventDTO = { page: 1, limit: 10 } as QueryEventDTO;

      const result = await controller.getMyManagedEvents(mockUser, query);

      expect(eventService.getMyManagedEvents).toHaveBeenCalledWith(
        mockUser,
        query
      );
      expect(result).toEqual(eventsResult);
    });
  });

  describe("assignOrganizer", () => {
    it("delegates to addOrganizerToEvent with the target userId", async () => {
      const dto: AssignOrganizerDto = {
        userId: "507f1f77bcf86cd799439099",
      };
      const updated = { id: mockEventId, organizerIds: [dto.userId] };
      eventService.addOrganizerToEvent.mockResolvedValue(updated);

      const result = await controller.assignOrganizer(
        mockUser,
        mockEventId,
        dto
      );

      expect(eventService.addOrganizerToEvent).toHaveBeenCalledWith(
        mockUser,
        mockEventId,
        dto.userId
      );
      expect(result).toEqual(updated);
    });
  });

  describe("removeOrganizer", () => {
    it("delegates to removeOrganizerFromEvent", async () => {
      const targetUserId = "507f1f77bcf86cd799439099";
      const updated = { id: mockEventId, organizerIds: [] };
      eventService.removeOrganizerFromEvent.mockResolvedValue(updated);

      const result = await controller.removeOrganizer(
        mockUser,
        mockEventId,
        targetUserId
      );

      expect(eventService.removeOrganizerFromEvent).toHaveBeenCalledWith(
        mockUser,
        mockEventId,
        targetUserId
      );
      expect(result).toEqual(updated);
    });
  });

  describe("getEventStaff", () => {
    it("delegates to eventService.getEventStaff", async () => {
      const staff = [{ _id: "u1", email: "a@b.com" }];
      eventService.getEventStaff.mockResolvedValue(staff as any);

      const result = await controller.getEventStaff(mockUser, mockEventId);

      expect(eventService.getEventStaff).toHaveBeenCalledWith(
        mockUser,
        mockEventId
      );
      expect(result).toEqual(staff);
    });
  });

  describe("assignStaff", () => {
    it("delegates to addStaffToEvent with userId and notes", async () => {
      const dto = { userId: "507f1f77bcf86cd799439099", notes: "Gate A" };
      const updated = { id: mockEventId, staffIds: [dto.userId] };
      eventService.addStaffToEvent.mockResolvedValue(updated as any);

      const result = await controller.assignStaff(mockUser, mockEventId, dto);

      expect(eventService.addStaffToEvent).toHaveBeenCalledWith(
        mockUser,
        mockEventId,
        dto.userId,
        dto.notes
      );
      expect(result).toEqual(updated);
    });
  });

  describe("removeStaff", () => {
    it("delegates to removeStaffFromEvent", async () => {
      const targetUserId = "507f1f77bcf86cd799439099";
      const updated = { id: mockEventId, staffIds: [] };
      eventService.removeStaffFromEvent.mockResolvedValue(updated as any);

      const result = await controller.removeStaff(
        mockUser,
        mockEventId,
        targetUserId
      );

      expect(eventService.removeStaffFromEvent).toHaveBeenCalledWith(
        mockUser,
        mockEventId,
        targetUserId
      );
      expect(result).toEqual(updated);
    });
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer to create/update events and manage organizers/staff", () => {
      expect(reflector.get(ROLES_KEY, controller.createEvent)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.updateEvent)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.assignOrganizer)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.removeOrganizer)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.getMyManagedEvents)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.getEventStaff)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.assignStaff)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.removeStaff)).toEqual([
        "admin",
        "organizer",
      ]);
    });

    it("keeps destructive event actions admin-only", () => {
      expect(reflector.get(ROLES_KEY, controller.deleteEvent)).toEqual([
        "admin",
      ]);
      expect(reflector.get(ROLES_KEY, controller.restoreEvent)).toEqual([
        "admin",
      ]);
      expect(reflector.get(ROLES_KEY, controller.cancelEvent)).toEqual([
        "admin",
      ]);
    });
  });

  describe("error propagation", () => {
    it("propagates errors from getEvents", async () => {
      eventService.getEvents.mockRejectedValue(new Error("Service error"));
      await expect(
        controller.getEvents({} as QueryEventDTO, mockUser)
      ).rejects.toThrow("Service error");
    });

    it("propagates errors from getEventZones", async () => {
      eventService.getEventZones.mockRejectedValue(new Error("Not found"));
      await expect(
        controller.getEventZones("bad-id", mockUser)
      ).rejects.toThrow("Not found");
    });

    it("propagates errors from createEvent", async () => {
      eventService.createEvent.mockRejectedValue(
        new Error("Validation failed")
      );
      await expect(
        controller.createEvent(mockUser, {} as CreateEventDTO)
      ).rejects.toThrow("Validation failed");
    });

    it("propagates errors from updateEvent", async () => {
      eventService.updateEvent.mockRejectedValue(new Error("Event not found"));
      await expect(
        controller.updateEvent(mockUser, "nonexistent", {} as UpdateEventDTO)
      ).rejects.toThrow("Event not found");
    });

    it("propagates errors from deleteEvent", async () => {
      eventService.deleteEvent.mockRejectedValue(new Error("Not found"));
      await expect(controller.deleteEvent("bad-id")).rejects.toThrow(
        "Not found"
      );
    });

    it("propagates errors from restoreEvent", async () => {
      eventService.restoreEvent.mockRejectedValue(new Error("Not found"));
      await expect(controller.restoreEvent("bad-id")).rejects.toThrow(
        "Not found"
      );
    });

    it("propagates errors from cancelEvent", async () => {
      eventService.cancelEventWithRefund.mockRejectedValue(
        new Error("Already cancelled")
      );
      await expect(
        controller.cancelEvent(mockEventId, mockUser, {} as CancelEventDto)
      ).rejects.toThrow("Already cancelled");
    });
  });
});
