import { Test, TestingModule } from "@nestjs/testing";
import { Logger } from "@nestjs/common";
import { UserRegisterListener } from "./user-register.listener";
import { NotificationService } from "@src/notification/notification.service";

describe("UserRegisterListener", () => {
  let listener: UserRegisterListener;
  let notificationService: jest.Mocked<NotificationService>;

  beforeEach(async () => {
    notificationService = {
      notifyRegisterSuccess: jest.fn().mockResolvedValue(undefined),
      queueEmailVerification: jest.fn().mockResolvedValue(undefined),
      queuePasswordReset: jest.fn().mockResolvedValue(undefined),
      queueBookingConfirmationEmail: jest.fn().mockResolvedValue(undefined),
    } as any;

    jest.spyOn(Logger.prototype, "error").mockImplementation(() => {});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserRegisterListener,
        { provide: NotificationService, useValue: notificationService },
      ],
    }).compile();

    listener = module.get(UserRegisterListener);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("handleUserRegisteredEvent", () => {
    it("sends register email with user payload", async () => {
      const user = {
        _id: "user1",
        email: "test@test.com",
        fullName: "Test User",
      } as any;
      await listener.handleUserRegisteredEvent(user);
      expect(notificationService.notifyRegisterSuccess).toHaveBeenCalledWith({
        userId: "user1",
        email: "test@test.com",
        fullName: "Test User",
      });
    });

    it("logs error when mail service fails", async () => {
      notificationService.notifyRegisterSuccess.mockRejectedValue(
        new Error("SMTP error")
      );
      await listener.handleUserRegisteredEvent({
        _id: "user1",
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
      expect(notificationService.queuePasswordReset).toHaveBeenCalledWith({
        email: "a@b.com",
        resetToken: "tok",
        fullName: "Alice",
      });
    });

    it("logs error on failure", async () => {
      notificationService.queuePasswordReset.mockRejectedValue(
        new Error("fail")
      );
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
      expect(notificationService.queueEmailVerification).toHaveBeenCalledWith({
        email: "a@b.com",
        token: "tok-hex",
        fullName: "Alice",
      });
    });

    it("logs error on failure", async () => {
      notificationService.queueEmailVerification.mockRejectedValue(
        new Error("fail")
      );
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
      expect(
        notificationService.queueBookingConfirmationEmail
      ).toHaveBeenCalledWith(payload);
    });

    it("logs error on failure", async () => {
      notificationService.queueBookingConfirmationEmail.mockRejectedValue(
        new Error("fail")
      );
      await listener.handleBookingConfirmationEvent({
        bookingCode: "BK001",
      } as any);
      expect(Logger.prototype.error).toHaveBeenCalled();
    });
  });
});
