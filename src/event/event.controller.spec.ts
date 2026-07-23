import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Test, TestingModule } from "@nestjs/testing";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { OptionalJwtAuthGuard } from "@src/guards/optional.guard";
import { RolesGuard } from "@src/guards/role.guard";
import { EventCommandService } from "./application/event-command.service";
import { EventLifecycleService } from "./application/event-lifecycle.service";
import { EventMemberService } from "./application/event-member.service";
import { EventQueryService } from "./application/event-query.service";
import { EventLifecycleController } from "./controllers/event-lifecycle.controller";
import { EventManagementController } from "./controllers/event-management.controller";
import { EventMemberController } from "./controllers/event-member.controller";
import { EventQueryController } from "./controllers/event-query.controller";
import { CancelEventDto } from "./dto/cancel-event.dto";
import { CreateEventDTO } from "./dto/create-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";

describe("Event controllers", () => {
  let queryController: EventQueryController;
  let managementController: EventManagementController;
  let memberController: EventMemberController;
  let lifecycleController: EventLifecycleController;
  let queryService: jest.Mocked<EventQueryService>;
  let commandService: jest.Mocked<EventCommandService>;
  let memberService: jest.Mocked<EventMemberService>;
  let lifecycleService: jest.Mocked<EventLifecycleService>;

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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [
        EventQueryController,
        EventManagementController,
        EventMemberController,
        EventLifecycleController,
      ],
      providers: [
        {
          provide: EventQueryService,
          useValue: {
            getEvents: jest.fn(),
            getEventZones: jest.fn(),
            getDeletedEvents: jest.fn(),
            getActiveEventById: jest.fn(),
            getMyManagedEvents: jest.fn(),
          },
        },
        {
          provide: EventCommandService,
          useValue: {
            createEvent: jest.fn(),
            updateEvent: jest.fn(),
            deleteEvent: jest.fn(),
            restoreEvent: jest.fn(),
          },
        },
        {
          provide: EventMemberService,
          useValue: {
            addOrganizerToEvent: jest.fn(),
            removeOrganizerFromEvent: jest.fn(),
            getEventStaff: jest.fn(),
            addStaffToEvent: jest.fn(),
            removeStaffFromEvent: jest.fn(),
          },
        },
        {
          provide: EventLifecycleService,
          useValue: {
            publishEvent: jest.fn(),
            unpublishEvent: jest.fn(),
            endEvent: jest.fn(),
            cancelEventWithRefund: jest.fn(),
            getCancellationStatus: jest.fn(),
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

    queryController = module.get(EventQueryController);
    managementController = module.get(EventManagementController);
    memberController = module.get(EventMemberController);
    lifecycleController = module.get(EventLifecycleController);
    queryService = module.get(EventQueryService);
    commandService = module.get(EventCommandService);
    memberService = module.get(EventMemberService);
    lifecycleService = module.get(EventLifecycleService);
  });

  afterEach(() => jest.clearAllMocks());

  it("delegates query endpoints to EventQueryService", async () => {
    const query = { page: 1, limit: 10 } as QueryEventDTO;
    const zones = [{ name: "VIP", price: 100 }];
    queryService.getEvents.mockResolvedValue(eventsResult as any);
    queryService.getEventZones.mockResolvedValue(zones as any);
    queryService.getDeletedEvents.mockResolvedValue([
      { id: mockEventId },
    ] as any);
    queryService.getActiveEventById.mockResolvedValue({
      id: mockEventId,
    } as any);
    queryService.getMyManagedEvents.mockResolvedValue(eventsResult as any);

    await expect(queryController.getEvents(query, mockUser)).resolves.toBe(
      eventsResult
    );
    await expect(
      queryController.getEventZones(mockEventId, mockUser)
    ).resolves.toBe(zones);
    await expect(queryController.getDeletedEvents()).resolves.toEqual([
      { id: mockEventId },
    ]);
    await expect(queryController.getEventById(mockEventId)).resolves.toEqual({
      id: mockEventId,
    });
    await expect(
      queryController.getMyManagedEvents(mockUser, query)
    ).resolves.toBe(eventsResult);

    expect(queryService.getEvents).toHaveBeenCalledWith(query, mockUser);
    expect(queryService.getEventZones).toHaveBeenCalledWith(
      mockEventId,
      mockUser
    );
    expect(queryService.getMyManagedEvents).toHaveBeenCalledWith(
      mockUser,
      query
    );
  });

  it("delegates management endpoints to EventCommandService", async () => {
    const createDto = { title: "New Event" } as CreateEventDTO;
    const updateDto = { title: "Updated" } as UpdateEventDTO;
    commandService.createEvent.mockResolvedValue({ id: mockEventId } as any);
    commandService.updateEvent.mockResolvedValue({ id: mockEventId } as any);
    commandService.deleteEvent.mockResolvedValue({ id: mockEventId } as any);
    commandService.restoreEvent.mockResolvedValue({ id: mockEventId } as any);

    await managementController.createEvent(mockUser, createDto);
    await managementController.updateEvent(mockUser, mockEventId, updateDto);
    await managementController.deleteEvent(mockEventId);
    await managementController.restoreEvent(mockEventId);

    expect(commandService.createEvent).toHaveBeenCalledWith(
      mockUser,
      createDto
    );
    expect(commandService.updateEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId,
      updateDto
    );
    expect(commandService.deleteEvent).toHaveBeenCalledWith(mockEventId);
    expect(commandService.restoreEvent).toHaveBeenCalledWith(mockEventId);
  });

  it("delegates member endpoints to EventMemberService", async () => {
    const dto = { userId: "507f1f77bcf86cd799439099", notes: "Gate A" };
    memberService.addOrganizerToEvent.mockResolvedValue({
      id: mockEventId,
    } as any);
    memberService.removeOrganizerFromEvent.mockResolvedValue({
      id: mockEventId,
    } as any);
    memberService.getEventStaff.mockResolvedValue([{ id: dto.userId }] as any);
    memberService.addStaffToEvent.mockResolvedValue({ id: mockEventId } as any);
    memberService.removeStaffFromEvent.mockResolvedValue({
      id: mockEventId,
    } as any);

    await memberController.addOrganizer(mockUser, mockEventId, dto);
    await memberController.removeOrganizer(mockUser, mockEventId, dto.userId);
    await memberController.getEventStaff(mockUser, mockEventId);
    await memberController.addStaff(mockUser, mockEventId, dto);
    await memberController.removeStaff(mockUser, mockEventId, dto.userId);

    expect(memberService.addOrganizerToEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId,
      dto.userId
    );
    expect(memberService.removeOrganizerFromEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId,
      dto.userId
    );
    expect(memberService.getEventStaff).toHaveBeenCalledWith(
      mockUser,
      mockEventId
    );
    expect(memberService.addStaffToEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId,
      dto.userId,
      dto.notes
    );
    expect(memberService.removeStaffFromEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId,
      dto.userId
    );
  });

  it("delegates lifecycle endpoints to EventLifecycleService", async () => {
    const cancelDto: CancelEventDto = { reason: "Weather issue" };
    lifecycleService.publishEvent.mockResolvedValue({ id: mockEventId } as any);
    lifecycleService.unpublishEvent.mockResolvedValue({
      id: mockEventId,
    } as any);
    lifecycleService.endEvent.mockResolvedValue({ id: mockEventId } as any);
    lifecycleService.cancelEventWithRefund.mockResolvedValue({
      id: "job-1",
      eventId: mockEventId,
      initiatedBy: mockUser.userId,
      reason: cancelDto.reason,
      status: "pending",
      totalBookings: 0,
      processedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      failures: [],
    } as any);

    await lifecycleController.publishEvent(mockUser, mockEventId);
    await lifecycleController.unpublishEvent(mockUser, mockEventId);
    await lifecycleController.endEvent(mockUser, mockEventId);
    await lifecycleController.cancelEvent(mockEventId, mockUser, cancelDto);

    expect(lifecycleService.publishEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId
    );
    expect(lifecycleService.unpublishEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId
    );
    expect(lifecycleService.endEvent).toHaveBeenCalledWith(
      mockUser,
      mockEventId
    );
    expect(lifecycleService.cancelEventWithRefund).toHaveBeenCalledWith(
      mockEventId,
      mockUser.userId,
      cancelDto.reason
    );
  });

  /**
   * Contract lock for item 17 (production-readiness-audit-2026-07-22.md /
   * docs/API_CHANGELOG.md): POST /event/:id/cancel is async — it MUST return
   * an EventCancellationJobDetail job handle (id/status/counts), never the
   * old synchronous EventCancelResult shape (event/cancelled/failed) a
   * caller built against the pre-NEW#6 contract would expect. A future
   * regression that accidentally reverts to the old shape, or silently
   * drops a field the async contract promises, must fail this test.
   */
  it("returns the EventCancellationJobDetail contract from cancelEvent, not the old synchronous EventCancelResult shape", async () => {
    const cancelDto: CancelEventDto = { reason: "Weather issue" };
    const jobDetail = {
      id: "job-1",
      eventId: mockEventId,
      initiatedBy: mockUser.userId,
      reason: cancelDto.reason,
      status: "pending",
      totalBookings: 2137,
      processedCount: 0,
      succeededCount: 0,
      failedCount: 0,
      skippedCount: 0,
      failures: [],
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:00.000Z",
    };
    lifecycleService.cancelEventWithRefund.mockResolvedValue(jobDetail as any);

    const result = await lifecycleController.cancelEvent(
      mockEventId,
      mockUser,
      cancelDto
    );

    expect(result).toEqual(jobDetail);
    // Old EventCancelResult fields MUST NOT appear on the response.
    expect(result).not.toHaveProperty("event");
    expect(result).not.toHaveProperty("cancelled");
    expect(result).not.toHaveProperty("failed");
    // New async-contract fields MUST be present.
    expect(result).toHaveProperty("id");
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("succeededCount");
    expect(result).toHaveProperty("failedCount");
  });

  it("keeps route role metadata equivalent after controller split", () => {
    const reflector = new Reflector();

    expect(reflector.get(ROLES_KEY, managementController.createEvent)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(reflector.get(ROLES_KEY, managementController.updateEvent)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(reflector.get(ROLES_KEY, memberController.addOrganizer)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(reflector.get(ROLES_KEY, memberController.removeOrganizer)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(reflector.get(ROLES_KEY, lifecycleController.publishEvent)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(
      reflector.get(ROLES_KEY, lifecycleController.unpublishEvent)
    ).toEqual(["admin", "organizer"]);
    expect(reflector.get(ROLES_KEY, lifecycleController.endEvent)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(reflector.get(ROLES_KEY, managementController.deleteEvent)).toEqual([
      "admin",
    ]);
    expect(reflector.get(ROLES_KEY, managementController.restoreEvent)).toEqual(
      ["admin"]
    );
    expect(reflector.get(ROLES_KEY, lifecycleController.cancelEvent)).toEqual([
      "admin",
    ]);
    expect(
      reflector.get(ROLES_KEY, lifecycleController.getCancellationStatus)
    ).toEqual(["admin"]);
  });

  it("delegates getCancellationStatus to EventLifecycleService", async () => {
    lifecycleService.getCancellationStatus.mockResolvedValue({
      id: "job-1",
      status: "processing",
    } as any);

    const result = await lifecycleController.getCancellationStatus(mockEventId);

    expect(lifecycleService.getCancellationStatus).toHaveBeenCalledWith(
      mockEventId
    );
    expect(result).toEqual({ id: "job-1", status: "processing" });
  });
});
