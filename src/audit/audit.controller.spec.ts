import { Test, TestingModule } from "@nestjs/testing";
import { AuthGuard } from "@nestjs/passport";
import { Reflector } from "@nestjs/core";
import { AuditController } from "./audit.controller";
import { AuditService } from "./audit.service";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";

describe("AuditController", () => {
  let controller: AuditController;
  let auditService: jest.Mocked<AuditService>;

  const mockRes = {
    setHeader: jest.fn(),
    send: jest.fn(),
  } as any;

  beforeEach(async () => {
    auditService = {
      findAll: jest.fn(),
      findById: jest.fn(),
      exportCsv: jest.fn(),
    } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuditController],
      providers: [{ provide: AuditService, useValue: auditService }],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(AuditController);
  });

  afterEach(() => jest.clearAllMocks());

  it("is defined", () => expect(controller).toBeDefined());

  it("requires the admin role via @Roles metadata", () => {
    const roles = new Reflector().get(ROLES_KEY, AuditController);
    expect(roles).toEqual(["admin"]);
  });

  it("findAll delegates to service with the query", async () => {
    auditService.findAll.mockResolvedValue({
      data: [],
      page: 1,
      limit: 20,
      total: 0,
    });

    await controller.findAll({ action: "booking.cancel" } as any);
    expect(auditService.findAll).toHaveBeenCalledWith({
      action: "booking.cancel",
    });
  });

  it("findById delegates to service with the id", async () => {
    auditService.findById.mockResolvedValue({ id: "log-1" } as any);
    const result = await controller.findById("log-1");
    expect(auditService.findById).toHaveBeenCalledWith("log-1");
    expect(result).toEqual({ id: "log-1" });
  });

  it("export streams a CSV response with attachment headers", async () => {
    auditService.exportCsv.mockResolvedValue("id,action\n1,booking.cancel");

    await controller.export({} as any, mockRes);

    expect(mockRes.setHeader).toHaveBeenCalledWith("Content-Type", "text/csv");
    expect(mockRes.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      expect.stringContaining("attachment; filename=audit-log-export-")
    );
    expect(mockRes.send).toHaveBeenCalledWith("id,action\n1,booking.cancel");
  });
});
