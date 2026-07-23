import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { ReportScopePolicy } from "./report-scope.policy";

const adminUser: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};

const organizerUser: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "organizer",
  iat: 0,
  exp: 0,
};

describe("ReportScopePolicy", () => {
  let policy: ReportScopePolicy;
  let zoneModel: { findById: jest.Mock };
  let eventOwnershipService: {
    assertCanManageEvent: jest.Mock;
    getManagedEventIds: jest.Mock;
    getManagedEventIdsForOrganizer: jest.Mock;
  };

  beforeEach(() => {
    zoneModel = { findById: jest.fn() };
    eventOwnershipService = {
      assertCanManageEvent: jest.fn().mockResolvedValue(undefined),
      getManagedEventIds: jest.fn(),
      getManagedEventIdsForOrganizer: jest.fn(),
    };

    policy = new ReportScopePolicy(
      zoneModel as never,
      eventOwnershipService as unknown as EventOwnershipService
    );
  });

  describe("resolveEventScope", () => {
    it("returns an unrestricted scope for admin with no eventId/zoneId", async () => {
      const scope = await policy.resolveEventScope(adminUser);
      expect(scope).toEqual({});
      expect(eventOwnershipService.getManagedEventIds).not.toHaveBeenCalled();
    });

    it("restricts organizer with no eventId/zoneId to their managed events", async () => {
      const managedIds = [new Types.ObjectId(), new Types.ObjectId()];
      eventOwnershipService.getManagedEventIds.mockResolvedValue(managedIds);

      const scope = await policy.resolveEventScope(organizerUser);

      expect(scope).toEqual({ eventIdIn: managedIds });
      expect(eventOwnershipService.getManagedEventIds).toHaveBeenCalledWith(
        organizerUser
      );
    });

    it("returns an eventIdIn scope with zero elements when organizer manages nothing (matches no documents, not everything)", async () => {
      eventOwnershipService.getManagedEventIds.mockResolvedValue([]);

      const scope = await policy.resolveEventScope(organizerUser);

      expect(scope).toEqual({ eventIdIn: [] });
    });

    it("re-checks ownership and returns eventIdEq when an explicit eventId is given", async () => {
      const eventId = new Types.ObjectId().toHexString();

      const scope = await policy.resolveEventScope(organizerUser, eventId);

      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        organizerUser,
        eventId
      );
      expect(scope).toEqual({ eventIdEq: new Types.ObjectId(eventId) });
    });

    it("rejects an explicit eventId the organizer cannot manage", async () => {
      const eventId = new Types.ObjectId().toHexString();
      eventOwnershipService.assertCanManageEvent.mockRejectedValue(
        new ForbiddenException()
      );

      await expect(
        policy.resolveEventScope(organizerUser, eventId)
      ).rejects.toThrow(ForbiddenException);
    });

    it("resolves zoneId to its owning event and authorizes that event", async () => {
      const eventId = new Types.ObjectId();
      const zoneId = new Types.ObjectId().toHexString();
      zoneModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ eventId }),
      });

      const scope = await policy.resolveEventScope(
        organizerUser,
        undefined,
        zoneId
      );

      expect(eventOwnershipService.assertCanManageEvent).toHaveBeenCalledWith(
        organizerUser,
        eventId.toString()
      );
      expect(scope).toEqual({ eventIdEq: eventId });
    });

    it("throws NotFoundException when zoneId does not exist", async () => {
      const zoneId = new Types.ObjectId().toHexString();
      zoneModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(null),
      });

      await expect(
        policy.resolveEventScope(organizerUser, undefined, zoneId)
      ).rejects.toThrow(NotFoundException);
    });

    it("throws BadRequestException when zoneId belongs to a different eventId than the one given", async () => {
      const zoneOwningEventId = new Types.ObjectId();
      const otherEventId = new Types.ObjectId().toHexString();
      const zoneId = new Types.ObjectId().toHexString();
      zoneModel.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ eventId: zoneOwningEventId }),
      });

      await expect(
        policy.resolveEventScope(organizerUser, otherEventId, zoneId)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("resolveOrganizerScope", () => {
    it("allows admin to view any organizerId", async () => {
      const organizerId = new Types.ObjectId().toHexString();
      const managedIds = [new Types.ObjectId()];
      eventOwnershipService.getManagedEventIdsForOrganizer.mockResolvedValue(
        managedIds
      );

      const result = await policy.resolveOrganizerScope(adminUser, organizerId);

      expect(result).toBe(managedIds);
      expect(
        eventOwnershipService.getManagedEventIdsForOrganizer
      ).toHaveBeenCalledWith(organizerId);
    });

    it("allows organizer to view their own organizerId", async () => {
      eventOwnershipService.getManagedEventIdsForOrganizer.mockResolvedValue(
        []
      );

      await expect(
        policy.resolveOrganizerScope(organizerUser, organizerUser.userId)
      ).resolves.toEqual([]);
    });

    it("forbids organizer from viewing another organizer's report", async () => {
      const otherOrganizerId = new Types.ObjectId().toHexString();

      await expect(
        policy.resolveOrganizerScope(organizerUser, otherOrganizerId)
      ).rejects.toThrow(ForbiddenException);
      expect(
        eventOwnershipService.getManagedEventIdsForOrganizer
      ).not.toHaveBeenCalled();
    });

    it("rejects an invalid organizerId", async () => {
      await expect(
        policy.resolveOrganizerScope(adminUser, "not-a-valid-id")
      ).rejects.toThrow(BadRequestException);
    });
  });
});
