import { Test, TestingModule } from "@nestjs/testing";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { UserEventsService } from "./user-event.services";

describe("UserEventsService", () => {
  let service: UserEventsService;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  const mockUser = {
    _id: "user1",
    email: "test@test.com",
    fullName: "Test",
  } as any;

  beforeEach(async () => {
    eventEmitter = { emit: jest.fn() } as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserEventsService,
        { provide: EventEmitter2, useValue: eventEmitter },
      ],
    }).compile();

    service = module.get(UserEventsService);
  });

  it("emitUserRegistered emits user.registered event", () => {
    service.emitUserRegistered(mockUser);
    expect(eventEmitter.emit).toHaveBeenCalledWith("user.registered", mockUser);
  });

  it("emitPasswordResetRequested emits password.reset.requested event", () => {
    service.emitPasswordResetRequested("a@b.com", "tok123", "Alice");
    expect(eventEmitter.emit).toHaveBeenCalledWith("password.reset.requested", {
      email: "a@b.com",
      resetToken: "tok123",
      fullName: "Alice",
    });
  });

  it("emitPasswordResetSuccess emits password.reset.success event", () => {
    service.emitPasswordResetSuccess("a@b.com", "Alice");
    expect(eventEmitter.emit).toHaveBeenCalledWith("password.reset.success", {
      email: "a@b.com",
      fullName: "Alice",
    });
  });

  it("emitEmailVerificationRequested emits email.verification.requested event", () => {
    service.emitEmailVerificationRequested("a@b.com", "tok-hex", "Alice");
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      "email.verification.requested",
      {
        email: "a@b.com",
        token: "tok-hex",
        fullName: "Alice",
      }
    );
  });

  it("emitSendBookingConfirmation emits booking.confirmation event", () => {
    const data = { bookingCode: "BK001" } as any;
    service.emitSendBookingConfirmation(data);
    expect(eventEmitter.emit).toHaveBeenCalledWith(
      "booking.confirmation",
      data
    );
  });
});
