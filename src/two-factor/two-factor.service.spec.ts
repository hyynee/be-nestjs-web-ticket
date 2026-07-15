import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test, TestingModule } from "@nestjs/testing";
import { WINSTON_MODULE_PROVIDER } from "nest-winston";
import { authenticator } from "otplib";
import { TwoFactorService } from "./two-factor.service";

describe("TwoFactorService", () => {
  let service: TwoFactorService;
  let mockUserModel: any;
  let mockLogger: any;
  let selectMock: jest.Mock;
  // The document `select()` currently resolves to — `updateOne`'s mock below reads/mutates
  // its `twoFactorRecoveryCodes` array in place, so it behaves like a real atomic Mongo
  // $pull-if-present instead of unconditionally reporting success.
  let activeUser: any;

  const VALID_USER_ID = "64c1f2e1e1e1e1e1e1e1e1e1";
  const VALID_EMAIL = "admin@mail.com";

  const buildUser = (overrides: Record<string, unknown> = {}) => ({
    _id: VALID_USER_ID,
    email: VALID_EMAIL,
    role: "admin",
    twoFactorEnabled: false,
    twoFactorSecret: undefined as string | undefined,
    twoFactorRecoveryCodes: [] as string[],
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  });

  const useUser = (user: any) => {
    activeUser = user;
    selectMock.mockResolvedValue(user);
    return user;
  };

  beforeAll(() => {
    process.env.SECRET_KEY = "unit-test-secret-key-for-two-factor";
  });

  afterAll(() => {
    delete process.env.SECRET_KEY;
  });

  beforeEach(async () => {
    selectMock = jest.fn();
    activeUser = null;
    mockUserModel = {
      findById: jest.fn().mockReturnValue({ select: selectMock }),
      updateOne: jest.fn().mockImplementation((filter: any) => {
        const code = filter?.twoFactorRecoveryCodes;
        const codes: string[] = activeUser?.twoFactorRecoveryCodes ?? [];
        const idx = typeof code === "string" ? codes.indexOf(code) : -1;
        if (idx === -1) {
          return Promise.resolve({ acknowledged: true, modifiedCount: 0 });
        }
        codes.splice(idx, 1);
        return Promise.resolve({ acknowledged: true, modifiedCount: 1 });
      }),
    };

    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TwoFactorService,
        { provide: getModelToken("User"), useValue: mockUserModel },
        { provide: WINSTON_MODULE_PROVIDER, useValue: mockLogger },
      ],
    }).compile();

    service = module.get<TwoFactorService>(TwoFactorService);
  });

  describe("setup", () => {
    it("throws NotFoundException when the user does not exist", async () => {
      selectMock.mockResolvedValue(null);

      await expect(service.setup(VALID_USER_ID)).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws ForbiddenException for roles other than admin/organizer", async () => {
      useUser(buildUser({ role: "user" }));

      await expect(service.setup(VALID_USER_ID)).rejects.toThrow(
        ForbiddenException
      );
    });

    it("throws ConflictException when 2FA is already enabled", async () => {
      useUser(buildUser({ twoFactorEnabled: true }));

      await expect(service.setup(VALID_USER_ID)).rejects.toThrow(
        ConflictException
      );
    });

    it("generates a secret, recovery codes, and persists them encrypted/hashed (organizer allowed too)", async () => {
      const user = buildUser({ role: "organizer" });
      useUser(user);

      const result = await service.setup(VALID_USER_ID);

      expect(result.secret).toEqual(expect.any(String));
      expect(result.otpauthUrl).toContain("otpauth://totp/");
      expect(result.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
      expect(result.recoveryCodes).toHaveLength(8);
      expect(new Set(result.recoveryCodes).size).toBe(8);

      expect(user.save).toHaveBeenCalled();
      // Raw secret/codes are never what gets persisted.
      expect(user.twoFactorSecret).not.toBe(result.secret);
      expect(user.twoFactorRecoveryCodes).not.toEqual(result.recoveryCodes);
      expect(user.twoFactorEnabled).toBe(false);
    });
  });

  describe("confirmSetup", () => {
    it("throws NotFoundException when the user does not exist", async () => {
      selectMock.mockResolvedValue(null);

      await expect(
        service.confirmSetup(VALID_USER_ID, "123456")
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ConflictException when already enabled", async () => {
      useUser(buildUser({ twoFactorEnabled: true }));

      await expect(
        service.confirmSetup(VALID_USER_ID, "123456")
      ).rejects.toThrow(ConflictException);
    });

    it("throws BadRequestException when no setup was ever started", async () => {
      useUser(buildUser({ twoFactorSecret: undefined }));

      await expect(
        service.confirmSetup(VALID_USER_ID, "123456")
      ).rejects.toThrow(BadRequestException);
    });

    it("throws UnauthorizedException when the OTP is wrong", async () => {
      const user = buildUser();
      useUser(user);
      await service.setup(VALID_USER_ID); // stages a real encrypted secret on `user`
      useUser(user);

      await expect(
        service.confirmSetup(VALID_USER_ID, "000000")
      ).rejects.toThrow(UnauthorizedException);
      expect(user.twoFactorEnabled).toBe(false);
    });

    it("activates 2FA when the OTP matches the staged secret", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      useUser(user);

      const validOtp = authenticator.generate(setupResult.secret);
      const result = await service.confirmSetup(VALID_USER_ID, validOtp);

      expect(result.message).toContain("enabled");
      expect(user.twoFactorEnabled).toBe(true);
    });
  });

  describe("disable", () => {
    it("throws NotFoundException when the user does not exist", async () => {
      selectMock.mockResolvedValue(null);

      await expect(service.disable(VALID_USER_ID, "123456")).rejects.toThrow(
        NotFoundException
      );
    });

    it("throws BadRequestException when 2FA is not enabled", async () => {
      useUser(buildUser({ twoFactorEnabled: false }));

      await expect(service.disable(VALID_USER_ID, "123456")).rejects.toThrow(
        BadRequestException
      );
    });

    it("throws UnauthorizedException with a wrong OTP/recovery code", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);
      void setupResult;

      await expect(service.disable(VALID_USER_ID, "000000")).rejects.toThrow(
        UnauthorizedException
      );
    });

    it("disables 2FA and clears secret/recovery codes on valid OTP", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      const validOtp = authenticator.generate(setupResult.secret);
      const result = await service.disable(VALID_USER_ID, validOtp);

      expect(result.message).toContain("disabled");
      expect(user.twoFactorEnabled).toBe(false);
      expect(user.twoFactorSecret).toBeUndefined();
      expect(user.twoFactorRecoveryCodes).toEqual([]);
    });

    it("disables 2FA using a valid recovery code instead of an OTP", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      const result = await service.disable(
        VALID_USER_ID,
        setupResult.recoveryCodes[0]
      );

      expect(result.message).toContain("disabled");
    });
  });

  describe("regenerateRecoveryCodes", () => {
    it("throws BadRequestException when 2FA is not enabled", async () => {
      useUser(buildUser({ twoFactorEnabled: false }));

      await expect(
        service.regenerateRecoveryCodes(VALID_USER_ID, "123456")
      ).rejects.toThrow(BadRequestException);
    });

    it("throws UnauthorizedException with a wrong OTP", async () => {
      const user = buildUser();
      useUser(user);
      await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      await expect(
        service.regenerateRecoveryCodes(VALID_USER_ID, "000000")
      ).rejects.toThrow(UnauthorizedException);
    });

    it("replaces the recovery codes and invalidates the old ones", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      const validOtp = authenticator.generate(setupResult.secret);
      const result = await service.regenerateRecoveryCodes(
        VALID_USER_ID,
        validOtp
      );

      expect(result.recoveryCodes).toHaveLength(8);
      expect(result.recoveryCodes).not.toEqual(setupResult.recoveryCodes);

      // Old recovery codes must no longer verify.
      useUser(user);
      const stillValid = await service
        .disable(VALID_USER_ID, setupResult.recoveryCodes[0])
        .catch(() => "rejected");
      expect(stillValid).toBe("rejected");
    });
  });

  describe("verifyLoginOtp", () => {
    it("returns false when the user does not exist", async () => {
      selectMock.mockResolvedValue(null);

      await expect(
        service.verifyLoginOtp(VALID_USER_ID, "123456")
      ).resolves.toBe(false);
    });

    it("returns false when 2FA is not enabled", async () => {
      useUser(buildUser({ twoFactorEnabled: false }));

      await expect(
        service.verifyLoginOtp(VALID_USER_ID, "123456")
      ).resolves.toBe(false);
    });

    it("returns true for a valid TOTP code", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      const validOtp = authenticator.generate(setupResult.secret);
      await expect(
        service.verifyLoginOtp(VALID_USER_ID, validOtp)
      ).resolves.toBe(true);
    });

    it("returns false for an invalid code", async () => {
      const user = buildUser();
      useUser(user);
      await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      await expect(
        service.verifyLoginOtp(VALID_USER_ID, "000000")
      ).resolves.toBe(false);
    });

    it("consumes the recovery code so it cannot be reused (single-use)", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      const code = setupResult.recoveryCodes[0];
      await expect(service.verifyLoginOtp(VALID_USER_ID, code)).resolves.toBe(
        true
      );
      expect(mockUserModel.updateOne).toHaveBeenCalledWith(
        { _id: user._id, twoFactorRecoveryCodes: expect.any(String) },
        { $pull: { twoFactorRecoveryCodes: expect.any(String) } }
      );
    });

    it("rejects a second use of the same recovery code — the atomic $pull-if-present only ever matches once, closing the race window", async () => {
      const user = buildUser();
      useUser(user);
      const setupResult = await service.setup(VALID_USER_ID);
      user.twoFactorEnabled = true;
      useUser(user);

      const code = setupResult.recoveryCodes[0];

      // First consumer wins: the atomic filter still matches, modifiedCount === 1.
      await expect(service.verifyLoginOtp(VALID_USER_ID, code)).resolves.toBe(
        true
      );

      // A second attempt with the exact same code (e.g. a request that lost the race,
      // or a naive replay) must fail — the code is no longer in the array to match.
      await expect(service.verifyLoginOtp(VALID_USER_ID, code)).resolves.toBe(
        false
      );
    });
  });
});
