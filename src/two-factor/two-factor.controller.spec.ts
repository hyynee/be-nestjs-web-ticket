import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { AuthGuard } from "@nestjs/passport";
import { GUARDS_METADATA } from "@nestjs/common/constants";
import { RolesGuard } from "@src/guards/role.guard";
import { ROLES_KEY } from "@src/common/decorators/roles.decorator";
import { TwoFactorController } from "./two-factor.controller";
import { TwoFactorService } from "./two-factor.service";

describe("TwoFactorController", () => {
  let controller: TwoFactorController;

  const mockTwoFactorService = {
    setup: jest.fn(),
    confirmSetup: jest.fn(),
    disable: jest.fn(),
    regenerateRecoveryCodes: jest.fn(),
  };

  const mockCurrentUser = {
    userId: "user-1",
    role: "admin",
    iat: 1,
    exp: 2,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const module: TestingModule = await Test.createTestingModule({
      controllers: [TwoFactorController],
      providers: [
        { provide: TwoFactorService, useValue: mockTwoFactorService },
      ],
    })
      .overrideGuard(AuthGuard("jwt"))
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: jest.fn().mockResolvedValue(true) })
      .compile();

    controller = module.get<TwoFactorController>(TwoFactorController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });

  it("restricts every route to admin/organizer via @Roles metadata", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, TwoFactorController);
    expect(roles).toEqual(["admin", "organizer"]);
  });

  it("applies AuthGuard(jwt) + RolesGuard at the controller level", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, TwoFactorController);
    expect(guards).toHaveLength(2);
  });

  describe("POST /auth/2fa/setup", () => {
    it("calls twoFactorService.setup with the current user id", async () => {
      const setupResult = {
        secret: "SECRET",
        otpauthUrl: "otpauth://totp/x",
        qrCodeDataUrl: "data:image/png;base64,xxx",
        recoveryCodes: ["a", "b"],
      };
      mockTwoFactorService.setup.mockResolvedValue(setupResult);

      const result = await controller.setup(mockCurrentUser as any);

      expect(mockTwoFactorService.setup).toHaveBeenCalledWith("user-1");
      expect(result).toEqual(setupResult);
    });

    it("propagates errors from the service", async () => {
      mockTwoFactorService.setup.mockRejectedValue(
        new Error("Two-factor authentication is already enabled")
      );

      await expect(controller.setup(mockCurrentUser as any)).rejects.toThrow(
        "Two-factor authentication is already enabled"
      );
    });
  });

  describe("POST /auth/2fa/verify", () => {
    it("calls twoFactorService.confirmSetup with the current user id and otp", async () => {
      mockTwoFactorService.confirmSetup.mockResolvedValue({
        message: "Two-factor authentication enabled successfully",
      });

      const result = await controller.verify(
        mockCurrentUser as any,
        {
          otp: "123456",
        } as any
      );

      expect(mockTwoFactorService.confirmSetup).toHaveBeenCalledWith(
        "user-1",
        "123456"
      );
      expect(result.message).toContain("enabled");
    });
  });

  describe("POST /auth/2fa/disable", () => {
    it("calls twoFactorService.disable with the current user id and otp", async () => {
      mockTwoFactorService.disable.mockResolvedValue({
        message: "Two-factor authentication disabled successfully",
      });

      const result = await controller.disable(
        mockCurrentUser as any,
        {
          otp: "123456",
        } as any
      );

      expect(mockTwoFactorService.disable).toHaveBeenCalledWith(
        "user-1",
        "123456"
      );
      expect(result.message).toContain("disabled");
    });
  });

  describe("POST /auth/2fa/recovery-codes/regenerate", () => {
    it("calls twoFactorService.regenerateRecoveryCodes with the current user id and otp", async () => {
      mockTwoFactorService.regenerateRecoveryCodes.mockResolvedValue({
        recoveryCodes: ["c", "d"],
      });

      const result = await controller.regenerateRecoveryCodes(
        mockCurrentUser as any,
        { otp: "123456" } as any
      );

      expect(mockTwoFactorService.regenerateRecoveryCodes).toHaveBeenCalledWith(
        "user-1",
        "123456"
      );
      expect(result.recoveryCodes).toEqual(["c", "d"]);
    });
  });
});
