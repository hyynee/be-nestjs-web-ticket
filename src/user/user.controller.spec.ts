import { Test, TestingModule } from "@nestjs/testing";
import { UserController } from "./user.controller";
import { UserService } from "./user.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";

describe("UserController", () => {
  let controller: UserController;

  const mockUserService = {
    updateProfileUser: jest.fn(),
    getTotalUserSpending: jest.fn(),
    getTotalUserSpendingInDay: jest.fn(),
    getTotalUserSpendingInMonth: jest.fn(),
    getTotalUserSpendingInYear: jest.fn(),
    getAllUser: jest.fn(),
    getUserById: jest.fn(),
  };

  const mockCurrentUser = {
    userId: "user-1",
    role: "user",
    iat: 123,
    exp: 456,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [{ provide: UserService, useValue: mockUserService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<UserController>(UserController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("PATCH /user/update-profile", () => {
    it("should call updateProfileUser with userId and data", async () => {
      const data = { fullName: "John Doe" };
      const expected = { _id: "user-1", fullName: "John Doe" };
      mockUserService.updateProfileUser.mockResolvedValue(expected);

      const result = await controller.updateProfileUser(
        mockCurrentUser as any,
        data as any
      );

      expect(mockUserService.updateProfileUser).toHaveBeenCalledWith(
        "user-1",
        data
      );
      expect(result).toEqual(expected);
    });
  });

  describe("GET /user/spending", () => {
    it("should call getTotalUserSpendingInDay when day is provided", async () => {
      const query = { day: 15, month: 6, year: 2024 };
      const expected = { totalSpending: 500000 };
      mockUserService.getTotalUserSpendingInDay.mockResolvedValue(expected);

      const result = await controller.getUserSpending(
        mockCurrentUser as any,
        query as any
      );

      expect(mockUserService.getTotalUserSpendingInDay).toHaveBeenCalledWith(
        "user-1",
        15,
        6,
        2024
      );
      expect(result).toEqual(expected);
    });

    it("should call getTotalUserSpendingInDay with defaults for month and year when only day is given", async () => {
      const now = new Date();
      const month = now.getMonth() + 1;
      const year = now.getFullYear();
      const query = { day: 1 };
      mockUserService.getTotalUserSpendingInDay.mockResolvedValue({
        totalSpending: 0,
      });

      await controller.getUserSpending(mockCurrentUser as any, query as any);

      expect(mockUserService.getTotalUserSpendingInDay).toHaveBeenCalledWith(
        "user-1",
        1,
        month,
        year
      );
    });

    it("should call getTotalUserSpendingInMonth when month is provided but no day", async () => {
      const query = { month: 3, year: 2024 };
      const expected = { totalSpending: 300000 };
      mockUserService.getTotalUserSpendingInMonth.mockResolvedValue(expected);

      const result = await controller.getUserSpending(
        mockCurrentUser as any,
        query as any
      );

      expect(mockUserService.getTotalUserSpendingInMonth).toHaveBeenCalledWith(
        "user-1",
        3,
        2024
      );
      expect(result).toEqual(expected);
    });

    it("should call getTotalUserSpendingInMonth with default year when only month is given", async () => {
      const year = new Date().getFullYear();
      const query = { month: 7 };
      mockUserService.getTotalUserSpendingInMonth.mockResolvedValue({
        totalSpending: 0,
      });

      await controller.getUserSpending(mockCurrentUser as any, query as any);

      expect(mockUserService.getTotalUserSpendingInMonth).toHaveBeenCalledWith(
        "user-1",
        7,
        year
      );
    });

    it("should call getTotalUserSpendingInYear when year is provided but no day or month", async () => {
      const query = { year: 2024 };
      const expected = { totalSpending: 1200000 };
      mockUserService.getTotalUserSpendingInYear.mockResolvedValue(expected);

      const result = await controller.getUserSpending(
        mockCurrentUser as any,
        query as any
      );

      expect(mockUserService.getTotalUserSpendingInYear).toHaveBeenCalledWith(
        "user-1",
        2024
      );
      expect(result).toEqual(expected);
    });

    it("should call getTotalUserSpending when no day, month, or year is provided", async () => {
      const query = {};
      const expected = { totalSpending: 2500000 };
      mockUserService.getTotalUserSpending.mockResolvedValue(expected);

      const result = await controller.getUserSpending(
        mockCurrentUser as any,
        query as any
      );

      expect(mockUserService.getTotalUserSpending).toHaveBeenCalledWith(
        "user-1"
      );
      expect(result).toEqual(expected);
    });
  });

  describe("GET /user/getAllUser", () => {
    it("should call getAllUser with query DTO", async () => {
      const query = { page: 1, limit: 10 };
      const expected = {
        data: [],
        total: 0,
        page: 1,
        limit: 10,
        totalPages: 0,
      };
      mockUserService.getAllUser.mockResolvedValue(expected);

      const result = await controller.getAllUser(query as any);

      expect(mockUserService.getAllUser).toHaveBeenCalledWith(query);
      expect(result).toEqual(expected);
    });
  });

  describe("GET /user/:id", () => {
    it("should call getUserById with id", async () => {
      const id = "507f1f77bcf86cd799439011";
      const expected = { _id: id, email: "test@test.com" };
      mockUserService.getUserById.mockResolvedValue(expected);

      const result = await controller.getUserById(id);

      expect(mockUserService.getUserById).toHaveBeenCalledWith(id);
      expect(result).toEqual(expected);
    });
  });
});
