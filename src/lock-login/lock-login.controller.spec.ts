import { Test, TestingModule } from "@nestjs/testing";
import { LockLoginController } from "./lock-login.controller";
import { LockLoginService } from "./lock-login.service";

describe("LockLoginController", () => {
  let controller: LockLoginController;

  const mockLockLoginService = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [LockLoginController],
      providers: [
        { provide: LockLoginService, useValue: mockLockLoginService },
      ],
    }).compile();

    controller = module.get<LockLoginController>(LockLoginController);
  });

  it("should be defined", () => {
    expect(controller).toBeDefined();
  });
});
