import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { AreaController } from "./area.controller";
import { AreaService } from "./area.service";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { BadRequestException } from "@nestjs/common";

describe("AreaController", () => {
  let controller: AreaController;
  let areaService: Record<string, jest.Mock>;

  const VALID_ID = "64c1f2e1e1e1e1e1e1e1e1e1";
  const VALID_ZONE_ID = "64c1f2e1e1e1e1e1e1e1e1e2";
  const mockUser = { userId: "user123", role: "admin" };
  const mockArea = {
    _id: VALID_ID,
    zoneId: VALID_ZONE_ID,
    name: "VIP",
    rowLabel: "A",
    seatCount: 10,
    seats: ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10"],
    isDeleted: false,
  };

  beforeEach(async () => {
    areaService = {
      createArea: jest.fn(),
      getAllAreas: jest.fn(),
      softDeleteArea: jest.fn(),
      updateArea: jest.fn(),
      getAreaById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AreaController],
      providers: [{ provide: AreaService, useValue: areaService }],
    })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AreaController>(AreaController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe("createArea", () => {
    const createDto = {
      zoneId: VALID_ZONE_ID,
      name: "VIP",
      rowLabel: "A",
      seatCount: 10,
    };

    it("should call areaService.createArea and return created area", async () => {
      areaService.createArea.mockResolvedValue(mockArea);

      const result = await controller.createArea(
        mockUser as any,
        createDto as any
      );

      expect(areaService.createArea).toHaveBeenCalledWith(mockUser, createDto);
      expect(result).toEqual(mockArea);
    });

    it("should propagate error when service throws", async () => {
      const err = new BadRequestException("Zone not found");
      areaService.createArea.mockRejectedValue(err);

      await expect(
        controller.createArea(mockUser as any, createDto as any)
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw when zoneId is invalid", async () => {
      const err = new BadRequestException("Invalid zone ID");
      areaService.createArea.mockRejectedValue(err);

      await expect(
        controller.createArea(
          mockUser as any,
          { ...createDto, zoneId: "bad" } as any
        )
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getAllAreas", () => {
    const emptyPaginated = {
      items: [],
      meta: {
        currentPage: 1,
        itemsPerPage: 10,
        totalItems: 0,
        totalPages: 0,
        hasPreviousPage: false,
        hasNextPage: false,
      },
    };

    const populatedPaginated = {
      items: [mockArea],
      meta: {
        currentPage: 1,
        itemsPerPage: 10,
        totalItems: 1,
        totalPages: 1,
        hasPreviousPage: false,
        hasNextPage: false,
      },
    };

    it("should call areaService.getAllAreas with query and return paginated result", async () => {
      areaService.getAllAreas.mockResolvedValue(populatedPaginated);

      const query = {
        zoneId: VALID_ZONE_ID,
        page: 1,
        limit: 10,
        sortBy: "name",
        sortOrder: "asc" as const,
      };
      const result = await controller.getAllAreas(query as any);

      expect(areaService.getAllAreas).toHaveBeenCalledWith(query);
      expect(result).toEqual(populatedPaginated);
    });

    it("should return empty list when no areas exist", async () => {
      areaService.getAllAreas.mockResolvedValue(emptyPaginated);

      const result = await controller.getAllAreas({} as any);

      expect(result.items).toHaveLength(0);
      expect(result.meta.totalItems).toBe(0);
    });

    it("should pass zoneId filtering to service", async () => {
      areaService.getAllAreas.mockResolvedValue(emptyPaginated);

      await controller.getAllAreas({ zoneId: VALID_ZONE_ID } as any);

      expect(areaService.getAllAreas).toHaveBeenCalledWith(
        expect.objectContaining({ zoneId: VALID_ZONE_ID })
      );
    });

    it("should propagate error when service throws", async () => {
      areaService.getAllAreas.mockRejectedValue(
        new BadRequestException("Invalid zone ID")
      );

      await expect(
        controller.getAllAreas({ zoneId: "bad" } as any)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("softDeleteArea", () => {
    it("should call areaService.softDeleteArea with isDeleted: true", async () => {
      areaService.softDeleteArea.mockResolvedValue({
        ...mockArea,
        isDeleted: true,
      });

      const result = await controller.softDeleteArea(
        mockUser as any,
        VALID_ID,
        { isDeleted: true }
      );

      expect(areaService.softDeleteArea).toHaveBeenCalledWith(
        mockUser,
        VALID_ID,
        { isDeleted: true }
      );
      expect(result.isDeleted).toBe(true);
    });

    it("should call areaService.softDeleteArea with isDeleted: false (restore)", async () => {
      areaService.softDeleteArea.mockResolvedValue({
        ...mockArea,
        isDeleted: false,
      });

      const result = await controller.softDeleteArea(
        mockUser as any,
        VALID_ID,
        { isDeleted: false }
      );

      expect(areaService.softDeleteArea).toHaveBeenCalledWith(
        mockUser,
        VALID_ID,
        { isDeleted: false }
      );
      expect(result.isDeleted).toBe(false);
    });

    it("should propagate error when service throws", async () => {
      areaService.softDeleteArea.mockRejectedValue(
        new BadRequestException("Area not found")
      );

      await expect(
        controller.softDeleteArea(mockUser as any, VALID_ID, {
          isDeleted: true,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it("should throw when active bookings exist", async () => {
      areaService.softDeleteArea.mockRejectedValue(
        new BadRequestException("Cannot delete area: 3 active booking(s) exist")
      );

      await expect(
        controller.softDeleteArea(mockUser as any, VALID_ID, {
          isDeleted: true,
        })
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("updateArea", () => {
    const updateDto = { name: "premium" };

    it("should call areaService.updateArea with correct params", async () => {
      areaService.updateArea.mockResolvedValue({
        ...mockArea,
        name: "PREMIUM",
      });

      const result = await controller.updateArea(
        mockUser as any,
        VALID_ID,
        updateDto as any
      );

      expect(areaService.updateArea).toHaveBeenCalledWith(
        mockUser,
        VALID_ID,
        updateDto
      );
      expect(result.name).toBe("PREMIUM");
    });

    it("should pass zoneId when updating zone", async () => {
      const newZoneDto = { zoneId: VALID_ZONE_ID, name: "VVIP" };
      areaService.updateArea.mockResolvedValue(mockArea);

      await controller.updateArea(mockUser as any, VALID_ID, newZoneDto as any);

      expect(areaService.updateArea).toHaveBeenCalledWith(
        mockUser,
        VALID_ID,
        newZoneDto
      );
    });

    it("should propagate error when service throws", async () => {
      areaService.updateArea.mockRejectedValue(
        new BadRequestException("Area not found or has been deleted")
      );

      await expect(
        controller.updateArea(mockUser as any, VALID_ID, updateDto as any)
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe("getAreaById", () => {
    it("should call areaService.getAreaById with id", async () => {
      areaService.getAreaById.mockResolvedValue(mockArea);

      const result = await controller.getAreaById(VALID_ID);

      expect(areaService.getAreaById).toHaveBeenCalledWith(VALID_ID);
      expect(result).toEqual(mockArea);
    });

    it("should throw when area not found", async () => {
      areaService.getAreaById.mockRejectedValue(
        new BadRequestException("Area not found or has been deleted")
      );

      await expect(controller.getAreaById(VALID_ID)).rejects.toThrow(
        BadRequestException
      );
    });

    it("should throw for invalid ObjectId format", async () => {
      areaService.getAreaById.mockRejectedValue(
        new BadRequestException("Invalid area ID")
      );

      await expect(controller.getAreaById("invalid")).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer to create/update/delete areas", () => {
      expect(reflector.get(ROLES_KEY, controller.createArea)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.updateArea)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.softDeleteArea)).toEqual([
        "admin",
        "organizer",
      ]);
    });
  });
});
