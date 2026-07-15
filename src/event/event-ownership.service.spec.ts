import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { EventOwnershipService } from "./event-ownership.service";
import { Event } from "@src/schemas/event.schema";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";

describe("EventOwnershipService", () => {
  let service: EventOwnershipService;
  let eventModel: any;

  const ownerId = new Types.ObjectId().toString();
  const organizerId = new Types.ObjectId().toString();
  const strangerId = new Types.ObjectId().toString();
  const eventId = new Types.ObjectId().toString();

  const adminUser: JwtPayload = {
    userId: new Types.ObjectId().toString(),
    role: "admin",
    iat: 0,
    exp: 0,
  };
  const ownerUser: JwtPayload = {
    userId: ownerId,
    role: "organizer",
    iat: 0,
    exp: 0,
  };
  const organizerUser: JwtPayload = {
    userId: organizerId,
    role: "organizer",
    iat: 0,
    exp: 0,
  };
  const strangerUser: JwtPayload = {
    userId: strangerId,
    role: "organizer",
    iat: 0,
    exp: 0,
  };

  const leanMock = (result: unknown) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(result),
  });

  beforeEach(async () => {
    eventModel = {
      findOne: jest.fn(),
      find: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventOwnershipService,
        { provide: getModelToken(Event.name), useValue: eventModel },
      ],
    }).compile();

    service = module.get(EventOwnershipService);
  });

  afterEach(() => jest.clearAllMocks());

  it("is defined", () => expect(service).toBeDefined());

  // ── assertCanManageEvent ──────────────────────────────────────────────────

  it("allows admin without querying the database", async () => {
    await service.assertCanManageEvent(adminUser, eventId);
    expect(eventModel.findOne).not.toHaveBeenCalled();
  });

  it("allows the event owner (createdBy)", async () => {
    eventModel.findOne.mockReturnValue(
      leanMock({
        _id: eventId,
        createdBy: new Types.ObjectId(ownerId),
        organizerIds: [],
      })
    );

    await expect(
      service.assertCanManageEvent(ownerUser, eventId)
    ).resolves.toBeUndefined();
  });

  it("allows an assigned organizer", async () => {
    eventModel.findOne.mockReturnValue(
      leanMock({
        _id: eventId,
        createdBy: new Types.ObjectId(),
        organizerIds: [new Types.ObjectId(organizerId)],
      })
    );

    await expect(
      service.assertCanManageEvent(organizerUser, eventId)
    ).resolves.toBeUndefined();
  });

  it("throws ForbiddenException for an organizer not assigned to the event", async () => {
    eventModel.findOne.mockReturnValue(
      leanMock({
        _id: eventId,
        createdBy: new Types.ObjectId(ownerId),
        organizerIds: [new Types.ObjectId(organizerId)],
      })
    );

    await expect(
      service.assertCanManageEvent(strangerUser, eventId)
    ).rejects.toThrow(ForbiddenException);
  });

  it("throws NotFoundException when the event does not exist or is deleted", async () => {
    eventModel.findOne.mockReturnValue(leanMock(null));

    await expect(
      service.assertCanManageEvent(organizerUser, eventId)
    ).rejects.toThrow(NotFoundException);
  });

  it("throws BadRequestException for a malformed event ID", async () => {
    await expect(
      service.assertCanManageEvent(organizerUser, "not-an-id")
    ).rejects.toThrow(BadRequestException);
    expect(eventModel.findOne).not.toHaveBeenCalled();
  });

  // ── getManagedEventIds ────────────────────────────────────────────────────

  it("returns an empty array for admin", async () => {
    const result = await service.getManagedEventIds(adminUser);
    expect(result).toEqual([]);
    expect(eventModel.find).not.toHaveBeenCalled();
  });

  it("returns owned + assigned event IDs for an organizer", async () => {
    const ids = [new Types.ObjectId(), new Types.ObjectId()];
    eventModel.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(ids.map((id) => ({ _id: id }))),
    });

    const result = await service.getManagedEventIds(organizerUser);
    expect(result).toEqual(ids);
    expect(eventModel.find).toHaveBeenCalledWith(
      expect.objectContaining({
        isDeleted: false,
        $or: expect.arrayContaining([
          { createdBy: new Types.ObjectId(organizerId) },
          { organizerIds: new Types.ObjectId(organizerId) },
        ]),
      })
    );
  });

  // ── hasCheckInAccess ──────────────────────────────────────────────────────

  describe("hasCheckInAccess", () => {
    const staffId = new Types.ObjectId().toString();
    const staffUser: JwtPayload = {
      userId: staffId,
      role: "checkin_staff",
      iat: 0,
      exp: 0,
    };

    it("allows admin without inspecting the event", () => {
      const result = service.hasCheckInAccess(adminUser, {
        createdBy: new Types.ObjectId(),
        organizerIds: [],
        staffIds: [],
      });
      expect(result).toBe(true);
    });

    it("allows the event owner", () => {
      const result = service.hasCheckInAccess(ownerUser, {
        createdBy: new Types.ObjectId(ownerId),
        organizerIds: [],
        staffIds: [],
      });
      expect(result).toBe(true);
    });

    it("allows an assigned organizer", () => {
      const result = service.hasCheckInAccess(organizerUser, {
        createdBy: new Types.ObjectId(),
        organizerIds: [new Types.ObjectId(organizerId)],
        staffIds: [],
      });
      expect(result).toBe(true);
    });

    it("allows an assigned checkin_staff", () => {
      const result = service.hasCheckInAccess(staffUser, {
        createdBy: new Types.ObjectId(),
        organizerIds: [],
        staffIds: [new Types.ObjectId(staffId)],
      });
      expect(result).toBe(true);
    });

    it("rejects a checkin_staff not assigned to this event", () => {
      const result = service.hasCheckInAccess(staffUser, {
        createdBy: new Types.ObjectId(),
        organizerIds: [],
        staffIds: [new Types.ObjectId()],
      });
      expect(result).toBe(false);
    });

    it("rejects a stranger with no role-based access", () => {
      const result = service.hasCheckInAccess(strangerUser, {
        createdBy: new Types.ObjectId(),
        organizerIds: [],
        staffIds: [],
      });
      expect(result).toBe(false);
    });

    it("treats missing organizerIds/staffIds as empty arrays without throwing", () => {
      const result = service.hasCheckInAccess(strangerUser, {
        createdBy: new Types.ObjectId(),
      });
      expect(result).toBe(false);
    });
  });
});
