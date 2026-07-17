import { Test, TestingModule } from "@nestjs/testing";
import { getModelToken } from "@nestjs/mongoose";
import { NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import { CACHE_MANAGER } from "@nestjs/cache-manager";
import { UserService } from "./user.service";
import { User } from "@src/schemas/user.schema";
import { Payment } from "@src/schemas/payment.schema";
import { UserCacheService } from "./infrastructure/cache/user-cache.service";
import { UserRepository } from "./infrastructure/persistence/user.repository";
import { UserPresenter } from "./presenters/user.presenter";

describe("UserService", () => {
  let service: UserService;
  let userModel: any;
  let paymentModel: any;
  let cacheManager: any;

  const userId = new Types.ObjectId().toString();

  beforeEach(async () => {
    userModel = {
      findByIdAndUpdate: jest.fn(),
      findById: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
    };

    paymentModel = {
      aggregate: jest.fn().mockResolvedValue([]),
    };

    cacheManager = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue(undefined),
      del: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        UserRepository,
        UserCacheService,
        UserPresenter,
        { provide: getModelToken(User.name), useValue: userModel },
        { provide: getModelToken(Payment.name), useValue: paymentModel },
        { provide: CACHE_MANAGER, useValue: cacheManager },
      ],
    }).compile();

    service = module.get(UserService);
  });

  describe("updateProfileUser", () => {
    it("returns updated user on success", async () => {
      const updatedUser = {
        _id: userId,
        email: "test@example.com",
        fullName: "Updated",
      };
      userModel.findByIdAndUpdate.mockReturnValue({
        select: jest.fn().mockResolvedValue(updatedUser),
      });

      const result = await service.updateProfileUser(userId, {
        fullName: "Updated",
      } as any);
      expect(result).toEqual(
        expect.objectContaining({
          id: userId,
          email: updatedUser.email,
          fullName: updatedUser.fullName,
        })
      );
    });

    it("invalidates cache after update", async () => {
      const updatedUser = { _id: userId, email: "test@example.com" };
      userModel.findByIdAndUpdate.mockReturnValue({
        select: jest.fn().mockResolvedValue(updatedUser),
      });

      await service.updateProfileUser(userId, {} as any);
      expect(cacheManager.del).toHaveBeenCalledWith(
        `user:details:v1:${userId}`
      );
    });

    it("throws NotFoundException when user not found", async () => {
      userModel.findByIdAndUpdate.mockReturnValue({
        select: jest.fn().mockResolvedValue(null),
      });

      await expect(
        service.updateProfileUser(userId, {} as any)
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("getUserById", () => {
    it("returns user when found", async () => {
      const user = { _id: userId, email: "user@example.com" };
      userModel.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue(user),
      });

      const result = await service.getUserById(userId);
      expect(result).toEqual(
        expect.objectContaining({
          id: userId,
          email: user.email,
        })
      );
    });

    it("throws NotFoundException when user does not exist", async () => {
      userModel.findById.mockReturnValue({
        select: jest.fn().mockResolvedValue(null),
      });

      await expect(service.getUserById(userId)).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("getAllUser", () => {
    it("returns paginated user list", async () => {
      const users = [{ _id: userId, email: "a@example.com" }];
      userModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue(users),
      });
      userModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(1),
      });

      const result = await service.getAllUser({ page: 1, limit: 10 });
      expect(result.data).toEqual([
        expect.objectContaining({
          id: userId,
          email: users[0].email,
        }),
      ]);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    });

    it("applies search filter when search is provided", async () => {
      userModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      userModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllUser({ search: "alice", page: 1, limit: 10 });
      const filter = userModel.find.mock.calls[0][0];
      expect(filter.$or).toBeDefined();
    });

    it("applies isActive filter when provided", async () => {
      userModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      userModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllUser({ isActive: true, page: 1, limit: 10 });
      const filter = userModel.find.mock.calls[0][0];
      expect(filter.isActive).toBe(true);
    });

    it("applies role filter when provided", async () => {
      userModel.find.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        skip: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockReturnThis(),
        exec: jest.fn().mockResolvedValue([]),
      });
      userModel.countDocuments.mockReturnValue({
        exec: jest.fn().mockResolvedValue(0),
      });

      await service.getAllUser({ role: "admin", page: 1, limit: 10 });
      const filter = userModel.find.mock.calls[0][0];
      expect(filter.role).toBe("admin");
    });
  });

  describe("getTotalUserSpending", () => {
    it("returns 0 when no payments found", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([]);
      const result = await service.getTotalUserSpending(userId);
      expect(result.totalSpending).toBe(0);
    });

    it("returns the aggregated total spending", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([{ totalSpending: 500000 }]);
      const result = await service.getTotalUserSpending(userId);
      expect(result.totalSpending).toBe(500000);
      expect(result.message).toBeTruthy();
    });

    it("throws NotFoundException when userId is empty", async () => {
      await expect(service.getTotalUserSpending("")).rejects.toThrow(
        NotFoundException
      );
    });
  });

  describe("getTotalUserSpendingInYear", () => {
    it("returns spending with year context", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([
        { totalSpending: 1000000 },
      ]);
      const result = await service.getTotalUserSpendingInYear(userId, 2026);
      expect(result.year).toBe(2026);
      expect(result.totalSpending).toBe(1000000);
    });

    it("returns 0 spending when no payments in the year", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([]);
      const result = await service.getTotalUserSpendingInYear(userId, 2020);
      expect(result.totalSpending).toBe(0);
    });
  });

  describe("getTotalUserSpendingInMonth", () => {
    it("returns spending with month and year", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([{ totalSpending: 200000 }]);
      const result = await service.getTotalUserSpendingInMonth(userId, 5, 2026);
      expect(result.month).toBe(5);
      expect(result.year).toBe(2026);
      expect(result.totalSpending).toBe(200000);
    });

    it("returns 0 for empty month", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([]);
      const result = await service.getTotalUserSpendingInMonth(userId, 1, 2020);
      expect(result.totalSpending).toBe(0);
    });
  });

  describe("getTotalUserSpendingInDay", () => {
    it("returns spending with day, month, year", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([{ totalSpending: 50000 }]);
      const result = await service.getTotalUserSpendingInDay(
        userId,
        15,
        5,
        2026
      );
      expect(result.day).toBe(15);
      expect(result.month).toBe(5);
      expect(result.year).toBe(2026);
      expect(result.totalSpending).toBe(50000);
    });

    it("returns 0 for empty day", async () => {
      paymentModel.aggregate.mockResolvedValueOnce([]);
      const result = await service.getTotalUserSpendingInDay(
        userId,
        1,
        1,
        2026
      );
      expect(result.totalSpending).toBe(0);
    });
  });
});
