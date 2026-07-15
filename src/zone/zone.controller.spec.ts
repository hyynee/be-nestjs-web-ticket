import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ZoneController } from "./zone.controller";
import { ZoneService } from "./zone.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";

describe("ZoneController", () => {
  let controller: ZoneController;

  const mockZoneService = {
    getAllActiveZones: jest.fn(),
    getZoneById: jest.fn(),
    getZoneWithAreas: jest.fn(),
    createZone: jest.fn(),
    updateZone: jest.fn(),
  };

  const mockAdminUser = {
    userId: "admin-1",
    role: "admin",
    iat: 123,
    exp: 456,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ZoneController],
      providers: [{ provide: ZoneService, useValue: mockZoneService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn().mockReturnValue(true) })
      .compile();

    controller = module.get<ZoneController>(ZoneController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  describe("GET /zone", () => {
    it("should call getAllActiveZones with query DTO", async () => {
      const query = { page: 1, limit: 10 };
      const expected = { items: [], meta: { currentPage: 1 } };
      mockZoneService.getAllActiveZones.mockResolvedValue(expected);

      const result = await controller.getAllZones(query as any);

      expect(mockZoneService.getAllActiveZones).toHaveBeenCalledWith(query);
      expect(result).toEqual(expected);
    });
  });

  describe("GET /zone/:id", () => {
    it("should call getZoneById with the id", async () => {
      const id = "507f1f77bcf86cd799439011";
      const expected = { _id: id, name: "VIP" };
      mockZoneService.getZoneById.mockResolvedValue(expected);

      const result = await controller.getZoneActiveById(id);

      expect(mockZoneService.getZoneById).toHaveBeenCalledWith(id);
      expect(result).toEqual(expected);
    });
  });

  describe("GET /zone/:id/with-areas", () => {
    it("should call getZoneWithAreas with zoneId", async () => {
      const zoneId = "507f1f77bcf86cd799439011";
      const expected = { _id: zoneId, areas: [] };
      mockZoneService.getZoneWithAreas.mockResolvedValue(expected);

      const result = await controller.getZoneWithAreas(zoneId);

      expect(mockZoneService.getZoneWithAreas).toHaveBeenCalledWith(zoneId);
      expect(result).toEqual(expected);
    });
  });

  describe("POST /zone", () => {
    it("should call createZone with currentUser and DTO", async () => {
      const dto = {
        eventId: "507f1f77bcf86cd799439011",
        name: "VIP",
        price: 500000,
      };
      const expected = { _id: "zone-1", name: "VIP" };
      mockZoneService.createZone.mockResolvedValue(expected);

      const result = await controller.createZone(
        mockAdminUser as any,
        dto as any
      );

      expect(mockZoneService.createZone).toHaveBeenCalledWith(
        mockAdminUser,
        dto
      );
      expect(result).toEqual(expected);
    });
  });

  describe("PUT /zone/update/:id", () => {
    it("should call updateZone with currentUser, id, and DTO", async () => {
      const id = "507f1f77bcf86cd799439011";
      const dto = { name: "VIP-Updated" };
      const expected = { _id: id, name: "VIP-UPDATED" };
      mockZoneService.updateZone.mockResolvedValue(expected);

      const result = await controller.updateZone(
        mockAdminUser as any,
        id,
        dto as any
      );

      expect(mockZoneService.updateZone).toHaveBeenCalledWith(
        mockAdminUser,
        id,
        dto
      );
      expect(result).toEqual(expected);
    });
  });

  describe("role metadata", () => {
    const reflector = new Reflector();

    it("allows both admin and organizer to create/update zones", () => {
      expect(reflector.get(ROLES_KEY, controller.createZone)).toEqual([
        "admin",
        "organizer",
      ]);
      expect(reflector.get(ROLES_KEY, controller.updateZone)).toEqual([
        "admin",
        "organizer",
      ]);
    });
  });
});
