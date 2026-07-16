import { BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AuthGuard } from "@nestjs/passport";
import { Test, TestingModule } from "@nestjs/testing";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { AreaCommandService } from "./application/area-command.service";
import { AreaQueryService } from "./application/area-query.service";
import { AreaManagementController } from "./controllers/area-management.controller";
import { AreaQueryController } from "./controllers/area-query.controller";

describe("Area controllers", () => {
  let managementController: AreaManagementController;
  let queryController: AreaQueryController;
  let commandService: Record<string, jest.Mock>;
  let queryService: Record<string, jest.Mock>;

  const validId = "64c1f2e1e1e1e1e1e1e1e1e1";
  const validZoneId = "64c1f2e1e1e1e1e1e1e1e1e2";
  const mockUser: JwtPayload = {
    userId: "user123",
    role: "admin",
    iat: 0,
    exp: 0,
  };
  const mockArea = {
    id: validId,
    eventId: validId,
    zoneId: validZoneId,
    name: "VIP",
    rowLabel: "A",
    seatCount: 10,
    seats: ["A1", "A2"],
  };

  beforeEach(async () => {
    commandService = {
      createArea: jest.fn(),
      softDeleteArea: jest.fn(),
      updateArea: jest.fn(),
    };
    queryService = {
      getAllAreas: jest.fn(),
      getAreaById: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AreaManagementController, AreaQueryController],
      providers: [
        { provide: AreaCommandService, useValue: commandService },
        { provide: AreaQueryService, useValue: queryService },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    managementController = module.get(AreaManagementController);
    queryController = module.get(AreaQueryController);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it("delegates management endpoints to AreaCommandService", async () => {
    const createDto = {
      zoneId: validZoneId,
      name: "VIP",
      rowLabel: "A",
      seatCount: 10,
    };
    const updateDto = { name: "premium" };
    commandService.createArea.mockResolvedValue(mockArea);
    commandService.softDeleteArea.mockResolvedValue({
      ...mockArea,
      isDeleted: true,
    });
    commandService.updateArea.mockResolvedValue({
      ...mockArea,
      name: "PREMIUM",
    });

    await expect(
      managementController.createArea(mockUser, createDto as any)
    ).resolves.toEqual(mockArea);
    await expect(
      managementController.softDeleteArea(mockUser, validId, {
        isDeleted: true,
      })
    ).resolves.toEqual({ ...mockArea, isDeleted: true });
    await expect(
      managementController.updateArea(mockUser, validId, updateDto as any)
    ).resolves.toEqual({ ...mockArea, name: "PREMIUM" });

    expect(commandService.createArea).toHaveBeenCalledWith(mockUser, createDto);
    expect(commandService.softDeleteArea).toHaveBeenCalledWith(
      mockUser,
      validId,
      { isDeleted: true }
    );
    expect(commandService.updateArea).toHaveBeenCalledWith(
      mockUser,
      validId,
      updateDto
    );
  });

  it("delegates query endpoints to AreaQueryService", async () => {
    const paginated = {
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
    const query = {
      zoneId: validZoneId,
      page: 1,
      limit: 10,
      sortBy: "name",
      sortOrder: "asc" as const,
    };
    queryService.getAllAreas.mockResolvedValue(paginated);
    queryService.getAreaById.mockResolvedValue(mockArea);

    await expect(queryController.getAllAreas(query as any)).resolves.toEqual(
      paginated
    );
    await expect(queryController.getAreaById(validId)).resolves.toEqual(
      mockArea
    );

    expect(queryService.getAllAreas).toHaveBeenCalledWith(query);
    expect(queryService.getAreaById).toHaveBeenCalledWith(validId);
  });

  it("propagates service errors", async () => {
    commandService.createArea.mockRejectedValue(
      new BadRequestException("Zone not found")
    );
    queryService.getAreaById.mockRejectedValue(
      new BadRequestException("Area not found or has been deleted")
    );

    await expect(
      managementController.createArea(mockUser, {
        zoneId: validZoneId,
        name: "VIP",
      } as any)
    ).rejects.toThrow(BadRequestException);
    await expect(queryController.getAreaById(validId)).rejects.toThrow(
      BadRequestException
    );
  });

  it("keeps role metadata equivalent after controller split", () => {
    const reflector = new Reflector();

    expect(reflector.get(ROLES_KEY, managementController.createArea)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(reflector.get(ROLES_KEY, managementController.updateArea)).toEqual([
      "admin",
      "organizer",
    ]);
    expect(
      reflector.get(ROLES_KEY, managementController.softDeleteArea)
    ).toEqual(["admin", "organizer"]);
    expect(reflector.get(ROLES_KEY, queryController.getAreaById)).toEqual([
      "admin",
    ]);
  });
});
