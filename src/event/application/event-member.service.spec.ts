import { BadRequestException } from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventMemberService } from "./event-member.service";

const admin: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};

describe("EventMemberService — report cache invalidation on organizer reassignment", () => {
  function makeService() {
    const eventId = new Types.ObjectId().toHexString();
    const targetUserId = new Types.ObjectId().toHexString();

    const eventDoc = {
      _id: eventId,
      createdBy: new Types.ObjectId(),
      organizerIds: [] as Types.ObjectId[],
      staffIds: [] as Types.ObjectId[],
      save: jest.fn().mockResolvedValue(undefined),
    };

    const session = {
      withTransaction: jest.fn(async (fn: () => Promise<void>) => fn()),
      endSession: jest.fn().mockResolvedValue(undefined),
    };

    const makeFindOneQuery = () => ({
      session: jest.fn().mockResolvedValue(eventDoc),
      then: (resolve: (value: unknown) => void) => resolve(eventDoc),
    });
    const eventModel = {
      db: { startSession: jest.fn().mockResolvedValue(session) },
      findOne: jest.fn().mockImplementation(() => makeFindOneQuery()),
    };
    const userModel = {
      findById: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnValue({
          session: jest.fn().mockResolvedValue({
            _id: targetUserId,
            role: "user",
            isActive: true,
          }),
        }),
      }),
      updateOne: jest.fn().mockResolvedValue({}),
    };
    const redisService = { client: { del: jest.fn().mockResolvedValue(1) } };
    const eventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
    };
    const auditService = { record: jest.fn().mockResolvedValue(undefined) };
    const eventCacheService = {
      invalidateEventCache: jest.fn().mockResolvedValue(undefined),
    };
    const reportCacheService = {
      invalidateAll: jest.fn().mockResolvedValue(undefined),
    };
    const eventPresenter = { toEventView: jest.fn((e: unknown) => e) };

    const service = new EventMemberService(
      eventModel as never,
      userModel as never,
      redisService as never,
      eventOwnershipService as never,
      auditService as never,
      eventCacheService as never,
      reportCacheService as never,
      eventPresenter as never
    );

    return { service, eventId, targetUserId, eventDoc, reportCacheService };
  }

  it("invalidates the report cache after successfully adding an organizer", async () => {
    const { service, eventId, targetUserId, reportCacheService } =
      makeService();

    await service.addOrganizerToEvent(admin, eventId, targetUserId);

    expect(reportCacheService.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache after successfully removing an organizer", async () => {
    const { service, eventId, targetUserId, eventDoc, reportCacheService } =
      makeService();
    eventDoc.organizerIds = [new Types.ObjectId(targetUserId)];

    await service.removeOrganizerFromEvent(admin, eventId, targetUserId);

    expect(reportCacheService.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("does not invalidate the report cache when removeOrganizer fails validation (user was never an organizer)", async () => {
    const { service, eventId, targetUserId, reportCacheService } =
      makeService();

    await expect(
      service.removeOrganizerFromEvent(admin, eventId, targetUserId)
    ).rejects.toThrow(BadRequestException);
    expect(reportCacheService.invalidateAll).not.toHaveBeenCalled();
  });

  it("does not fail the membership change when report cache invalidation rejects", async () => {
    const { service, eventId, targetUserId, reportCacheService } =
      makeService();
    reportCacheService.invalidateAll.mockRejectedValue(new Error("redis down"));

    await expect(
      service.addOrganizerToEvent(admin, eventId, targetUserId)
    ).resolves.toBeDefined();
  });
});
