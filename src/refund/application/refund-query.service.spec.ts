import { ForbiddenException } from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { RefundQueryService } from "./refund-query.service";

const user: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "user",
  iat: 0,
  exp: 0,
};
const admin: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};
const organizer: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "organizer",
  iat: 0,
  exp: 0,
};

describe("RefundQueryService", () => {
  function makeService(overrides: {
    managedEventIds?: Types.ObjectId[];
    rows?: unknown[];
    total?: number;
  }) {
    const repository = {
      findMany: jest.fn().mockResolvedValue({
        rows: overrides.rows ?? [],
        total: overrides.total ?? 0,
      }),
      loadRequestById: jest.fn(),
    };
    const presenter = {
      toDetail: jest.fn((row: unknown) => ({
        ...(row as object),
        presented: true,
      })),
    };
    const policy = {
      assertViewOwner: jest.fn(),
      assertCanReview: jest.fn().mockResolvedValue(undefined),
    };
    const eventOwnershipService = {
      getManagedEventIds: jest
        .fn()
        .mockResolvedValue(overrides.managedEventIds ?? []),
    };

    const service = new RefundQueryService(
      repository as never,
      presenter as never,
      policy as never,
      eventOwnershipService as never
    );

    return { service, repository, presenter, policy, eventOwnershipService };
  }

  describe("listMyRefundRequests", () => {
    it("always scopes the filter to the requesting user's own id", async () => {
      const { service, repository } = makeService({});

      await service.listMyRefundRequests(user, { page: 1, limit: 20 });

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: new Types.ObjectId(user.userId),
        }),
        1,
        20
      );
    });
  });

  describe("getMyRefundRequest", () => {
    it("forbids viewing a refund request owned by another user", async () => {
      const { service, repository, policy } = makeService({});
      repository.loadRequestById.mockResolvedValue({
        userId: new Types.ObjectId(),
      });
      policy.assertViewOwner.mockImplementation(() => {
        throw new ForbiddenException();
      });

      await expect(service.getMyRefundRequest(user, "id")).rejects.toThrow(
        ForbiddenException
      );
    });
  });

  describe("listRefundRequests (admin/organizer)", () => {
    it("does not scope by event for admin", async () => {
      const { service, repository, eventOwnershipService } = makeService({});

      await service.listRefundRequests(admin, { page: 1, limit: 20 });

      expect(eventOwnershipService.getManagedEventIds).not.toHaveBeenCalled();
      expect(repository.findMany).toHaveBeenCalledWith(
        expect.not.objectContaining({ eventId: expect.anything() }),
        1,
        20
      );
    });

    it("scopes an organizer's list to their managed events", async () => {
      const managedEventIds = [new Types.ObjectId(), new Types.ObjectId()];
      const { service, repository } = makeService({ managedEventIds });

      await service.listRefundRequests(organizer, { page: 1, limit: 20 });

      expect(repository.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: { $in: managedEventIds } }),
        1,
        20
      );
    });

    it("short-circuits to an empty result for an organizer who manages no events (does not fall back to unscoped)", async () => {
      const { service, repository } = makeService({ managedEventIds: [] });

      const result = await service.listRefundRequests(organizer, {
        page: 1,
        limit: 20,
      });

      expect(repository.findMany).not.toHaveBeenCalled();
      expect(result).toEqual({ items: [], total: 0, page: 1, limit: 20 });
    });
  });

  describe("getRefundRequest (admin/organizer detail)", () => {
    it("re-checks event-management authorization before returning the detail", async () => {
      const { service, repository, policy } = makeService({});
      const eventId = new Types.ObjectId();
      repository.loadRequestById.mockResolvedValue({ eventId });

      await service.getRefundRequest(organizer, "id");

      expect(policy.assertCanReview).toHaveBeenCalledWith(
        organizer,
        eventId.toString()
      );
    });

    it("propagates ForbiddenException when the organizer doesn't manage the request's event", async () => {
      const { service, repository, policy } = makeService({});
      repository.loadRequestById.mockResolvedValue({
        eventId: new Types.ObjectId(),
      });
      policy.assertCanReview.mockRejectedValue(new ForbiddenException());

      await expect(service.getRefundRequest(organizer, "id")).rejects.toThrow(
        ForbiddenException
      );
    });
  });
});
