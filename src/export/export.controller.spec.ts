import { Test, TestingModule } from "@nestjs/testing";
import { Reflector } from "@nestjs/core";
import { ExportController } from "./export.controller";
import { ExportService } from "./export.service";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import type { Response } from "express";

describe("ExportController", () => {
  let controller: ExportController;
  let exportService: jest.Mocked<ExportService>;

  const mockUser: JwtPayload = {
    userId: "admin-id",
    role: "admin",
    iat: 0,
    exp: 0,
  };

  const mockRes = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    send: jest.fn(),
  } as unknown as Response;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ExportController],
      providers: [
        {
          provide: ExportService,
          useValue: {
            exportTickets: jest.fn(),
            exportCheckInZones: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<ExportController>(ExportController);
    exportService = module.get(ExportService);
  });

  afterEach(() => jest.clearAllMocks());

  describe("exportTickets", () => {
    it("calls exportService.exportTickets with query, userId, and res", async () => {
      const query = {
        eventId: "507f1f77bcf86cd799439011",
        format: "csv",
      } as any;
      const serviceResponse = { message: "Queued", status: "queued" };
      exportService.exportTickets.mockResolvedValue(serviceResponse);

      const result = await controller.exportTickets(query, mockUser, mockRes);

      expect(exportService.exportTickets).toHaveBeenCalledWith(
        query,
        mockUser,
        mockRes
      );
      expect(result).toBe(serviceResponse);
    });

    it("passes all query fields to the service", async () => {
      const query = {
        eventId: "507f1f77bcf86cd799439011",
        zoneId: "507f1f77bcf86cd799439022",
        status: "valid",
        format: "xlsx",
        startDate: "2025-01-01",
        endDate: "2025-12-31",
      } as any;
      exportService.exportTickets.mockResolvedValue({ status: "queued" });

      await controller.exportTickets(query, mockUser, mockRes);

      expect(exportService.exportTickets).toHaveBeenCalledWith(
        query,
        mockUser,
        mockRes
      );
    });
  });

  describe("exportCheckInZones", () => {
    it("calls exportService.exportCheckInZones with query, userId, and res", async () => {
      const query = {
        eventId: "507f1f77bcf86cd799439011",
        format: "csv",
      } as any;
      const serviceResponse = { message: "Queued", status: "queued" };
      exportService.exportCheckInZones.mockResolvedValue(serviceResponse);

      const result = await controller.exportCheckInZones(
        query,
        mockUser,
        mockRes
      );

      expect(exportService.exportCheckInZones).toHaveBeenCalledWith(
        query,
        mockUser,
        mockRes
      );
      expect(result).toBe(serviceResponse);
    });

    it("passes the correct format to the service", async () => {
      const query = {
        eventId: "507f1f77bcf86cd799439011",
        format: "xlsx",
      } as any;
      exportService.exportCheckInZones.mockResolvedValue({ status: "queued" });

      await controller.exportCheckInZones(query, mockUser, mockRes);

      expect(exportService.exportCheckInZones).toHaveBeenCalledWith(
        query,
        mockUser,
        mockRes
      );
    });
  });

  describe("error propagation", () => {
    it("propagates errors from exportTickets", async () => {
      exportService.exportTickets.mockRejectedValue(
        new Error("Export queue full")
      );
      await expect(
        controller.exportTickets({} as any, mockUser, mockRes)
      ).rejects.toThrow("Export queue full");
    });

    it("propagates errors from exportCheckInZones", async () => {
      exportService.exportCheckInZones.mockRejectedValue(
        new Error("Event not found")
      );
      await expect(
        controller.exportCheckInZones({} as any, mockUser, mockRes)
      ).rejects.toThrow("Event not found");
    });
  });

  describe("role metadata", () => {
    it("allows both admin and organizer at the class level", () => {
      const roles = new Reflector().get(ROLES_KEY, ExportController);
      expect(roles).toEqual(["admin", "organizer"]);
    });
  });
});
