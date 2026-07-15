import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { UserRegisterListener } from "./user-register.listener";
import { MailService } from "@src/services/mail.service";

describe("UserRegisterListener", () => {
  let listener: UserRegisterListener;
  let mailService: jest.Mocked<MailService>;

  beforeEach(async () => {
    mailService = {
      sendRegisterEmail: jest.fn().mockResolvedValue(undefined),
      sendVerificationEmail: jest.fn().mockResolvedValue(undefined),
      sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
      sendBookingConfirmation: jest.fn().mockResolvedValue(undefined),
    } as any;

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserRegisterListener,
        { provide: MailService, useValue: mailService },
      ],
    }).compile();

    listener = module.get(UserRegisterListener);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("handleUserRegisteredEvent", () => {
    it("sends register email with user payload", async () => {
      const user = { email: "test@test.com", fullName: "Test User" } as any;
      await listener.handleUserRegisteredEvent(user);
      expect(mailService.sendRegisterEmail).toHaveBeenCalledWith(
        "test@test.com",
        "Test User"
      );
    });

    it("logs error when mail service fails", async () => {
      mailService.sendRegisterEmail.mockRejectedValue(new Error("SMTP error"));
      await listener.handleUserRegisteredEvent({
        email: "a@b.com",
        fullName: "A",
      } as any);
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe("handlePasswordResetEvent", () => {
    it("sends password reset email", async () => {
      await listener.handlePasswordResetEvent({
        email: "a@b.com",
        resetToken: "tok",
        fullName: "Alice",
      });
      expect(mailService.sendPasswordResetEmail).toHaveBeenCalledWith(
        "a@b.com",
        "tok",
        "Alice"
      );
    });

    it("logs error on failure", async () => {
      mailService.sendPasswordResetEmail.mockRejectedValue(new Error("fail"));
      await listener.handlePasswordResetEvent({
        email: "a@b.com",
        resetToken: "tok",
        fullName: "A",
      });
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe("handleEmailVerificationRequestedEvent", () => {
    it("sends verification email with payload", async () => {
      await listener.handleEmailVerificationRequestedEvent({
        email: "a@b.com",
        token: "tok-hex",
        fullName: "Alice",
      });
      expect(mailService.sendVerificationEmail).toHaveBeenCalledWith(
        "a@b.com",
        "tok-hex",
        "Alice"
      );
    });

    it("logs error on failure", async () => {
      mailService.sendVerificationEmail.mockRejectedValue(new Error("fail"));
      await listener.handleEmailVerificationRequestedEvent({
        email: "a@b.com",
        token: "tok-hex",
        fullName: "A",
      });
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });

  describe("handleBookingConfirmationEvent", () => {
    it("sends booking confirmation email", async () => {
      const payload = { bookingCode: "BK001" } as any;
      await listener.handleBookingConfirmationEvent(payload);
      expect(mailService.sendBookingConfirmation).toHaveBeenCalledWith(payload);
    });

    it("logs error on failure", async () => {
      mailService.sendBookingConfirmation.mockRejectedValue(new Error("fail"));
      await listener.handleBookingConfirmationEvent({
        bookingCode: "BK001",
      } as any);
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });
});
