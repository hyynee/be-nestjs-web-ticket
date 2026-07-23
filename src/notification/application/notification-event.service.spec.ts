import { Types } from "mongoose";
import { NotificationEventService } from "./notification-event.service";
import { NotificationEmailService } from "./notification-email.service";
import { NotificationWriterService } from "./notification-writer.service";

describe("NotificationEventService — report cache invalidation", () => {
  let writer: {
    createNotification: jest.Mock;
    resolveUserIdByEmail: jest.Mock;
  };
  let emails: { queueEmailNotification: jest.Mock };
  let reportCache: { invalidateAll: jest.Mock };
  let service: NotificationEventService;

  const userId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    writer = {
      createNotification: jest.fn().mockResolvedValue(undefined),
      resolveUserIdByEmail: jest.fn().mockResolvedValue(userId),
    };
    emails = {
      queueEmailNotification: jest.fn().mockResolvedValue(undefined),
    };
    reportCache = { invalidateAll: jest.fn().mockResolvedValue(undefined) };

    service = new NotificationEventService(
      writer as unknown as NotificationWriterService,
      emails as unknown as NotificationEmailService,
      reportCache as never
    );
  });

  it("invalidates the report cache on notifyBookingCreated", async () => {
    await service.notifyBookingCreated({
      userId,
      bookingId: "b1",
      bookingCode: "BK1",
    });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache on notifyBookingCancelled", async () => {
    await service.notifyBookingCancelled({
      userId,
      bookingId: "b1",
      bookingCode: "BK1",
    });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache on notifyPaymentSucceeded", async () => {
    await service.notifyPaymentSucceeded({
      userId,
      bookingCode: "BK1",
      provider: "stripe",
    });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache on notifyTicketsIssued", async () => {
    await service.notifyTicketsIssued({ userId, bookingCode: "BK1" });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache on notifyRefundReviewed (approved)", async () => {
    await service.notifyRefundReviewed({
      userId,
      bookingId: "b1",
      bookingCode: "BK1",
      eventId: "e1",
      refundRequestId: "r1",
      approved: true,
      amount: 1000,
    });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache on notifyRefundReviewed (rejected)", async () => {
    await service.notifyRefundReviewed({
      userId,
      bookingId: "b1",
      bookingCode: "BK1",
      eventId: "e1",
      refundRequestId: "r1",
      approved: false,
      amount: 1000,
    });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates the report cache on notifyRefundFailed", async () => {
    await service.notifyRefundFailed({
      userId,
      bookingId: "b1",
      bookingCode: "BK1",
      eventId: "e1",
      refundRequestId: "r1",
      amount: 1000,
    });
    expect(reportCache.invalidateAll).toHaveBeenCalledTimes(1);
  });

  it("does not fail the notification when report cache invalidation rejects", async () => {
    reportCache.invalidateAll.mockRejectedValue(new Error("redis down"));

    await expect(
      service.notifyBookingCreated({
        userId,
        bookingId: "b1",
        bookingCode: "BK1",
      })
    ).resolves.toBeUndefined();
  });

  it("does not invalidate the report cache for notifications outside the reportable set (register success)", async () => {
    await service.notifyRegisterSuccess({
      userId,
      email: "user@example.com",
      fullName: "User",
    });
    expect(reportCache.invalidateAll).not.toHaveBeenCalled();
  });
});

describe("NotificationEventService — genuine DB failure is not silently swallowed (item 15)", () => {
  let writer: {
    createNotification: jest.Mock;
    resolveUserIdByEmail: jest.Mock;
  };
  let emails: { queueEmailNotification: jest.Mock };
  let reportCache: { invalidateAll: jest.Mock };
  let metricsService: { notificationFailuresTotal: { inc: jest.Mock } };
  let service: NotificationEventService;

  const userId = new Types.ObjectId().toHexString();

  beforeEach(() => {
    writer = {
      createNotification: jest.fn(),
      resolveUserIdByEmail: jest.fn().mockResolvedValue(userId),
    };
    emails = { queueEmailNotification: jest.fn() };
    reportCache = { invalidateAll: jest.fn().mockResolvedValue(undefined) };
    metricsService = { notificationFailuresTotal: { inc: jest.fn() } };

    service = new NotificationEventService(
      writer as unknown as NotificationWriterService,
      emails as unknown as NotificationEmailService,
      reportCache as never,
      metricsService as never
    );
  });

  it("increments notificationFailuresTotal and does not throw on a genuine (non-duplicate-key) Mongo error", async () => {
    writer.createNotification.mockRejectedValue(
      new Error("connection timed out")
    );

    await expect(
      service.notifyBookingCreated({
        userId,
        bookingId: "b1",
        bookingCode: "BK1",
      })
    ).resolves.toBeUndefined();

    expect(metricsService.notificationFailuresTotal.inc).toHaveBeenCalledWith({
      channel: "in_app",
    });
  });

  it("increments notificationFailuresTotal for a genuine email delivery failure too", async () => {
    emails.queueEmailNotification.mockRejectedValue(
      new Error("connection timed out")
    );

    await expect(
      service.queueEmailVerification({
        email: "user@example.com",
        token: "tok",
        fullName: "User",
      })
    ).resolves.toBeUndefined();

    expect(metricsService.notificationFailuresTotal.inc).toHaveBeenCalledWith({
      channel: "email",
    });
  });

  it("does NOT increment notificationFailuresTotal for an unresolvable duplicate-key error (expected/benign)", async () => {
    const duplicateKeyError = Object.assign(new Error("E11000"), {
      code: 11000,
    });
    writer.createNotification.mockRejectedValue(duplicateKeyError);

    await expect(
      service.notifyBookingCreated({
        userId,
        bookingId: "b1",
        bookingCode: "BK1",
      })
    ).resolves.toBeUndefined();

    expect(metricsService.notificationFailuresTotal.inc).not.toHaveBeenCalled();
  });
});

describe("NotificationEventService — booking confirmation email idempotency keys", () => {
  /**
   * Regression guard for the bug where admin "resend confirmation" silently
   * did nothing: `queueBookingConfirmationEmail` (the automatic, dedup-
   * protected send) and `resendBookingConfirmationEmail` (the admin-forced
   * resend) MUST use different metadata.idempotencyKey values for the same
   * booking, or the resend collides with the original send's record and
   * NotificationWriterService's E11000 fallback returns the old (already
   * sent/failed) record without ever enqueueing a new email job.
   */
  it("queueBookingConfirmationEmail and resendBookingConfirmationEmail never produce the same idempotencyKey for the same booking", async () => {
    const writer = {
      createNotification: jest.fn().mockResolvedValue(undefined),
      resolveUserIdByEmail: jest
        .fn()
        .mockResolvedValue(new Types.ObjectId().toHexString()),
    };
    const emails = {
      queueEmailNotification: jest.fn().mockResolvedValue(undefined),
    };
    const reportCache = {
      invalidateAll: jest.fn().mockResolvedValue(undefined),
    };
    const metricsService = { notificationFailuresTotal: { inc: jest.fn() } };
    const service = new NotificationEventService(
      writer as unknown as NotificationWriterService,
      emails as unknown as NotificationEmailService,
      reportCache as never,
      metricsService as never
    );

    const payload = {
      email: "buyer@example.com",
      customerName: "Buyer",
      bookingCode: "BK-DEDUP-TEST",
      eventTitle: "Event",
      eventLocation: "HCMC",
      eventDate: new Date(),
      zoneName: "VIP",
      seats: [],
      quantity: 1,
      totalPrice: 100000,
      currency: "vnd",
      tickets: [],
    };

    await service.queueBookingConfirmationEmail(payload, "user-1");
    await service.resendBookingConfirmationEmail(payload, "user-1");

    const originalKey =
      emails.queueEmailNotification.mock.calls[0][0].metadata.idempotencyKey;
    const resendKey =
      emails.queueEmailNotification.mock.calls[1][0].metadata.idempotencyKey;

    expect(originalKey).not.toBe(resendKey);
  });

  it("two separate resend calls for the same booking also never collide with each other", async () => {
    const writer = {
      createNotification: jest.fn().mockResolvedValue(undefined),
      resolveUserIdByEmail: jest
        .fn()
        .mockResolvedValue(new Types.ObjectId().toHexString()),
    };
    const emails = {
      queueEmailNotification: jest.fn().mockResolvedValue(undefined),
    };
    const reportCache = {
      invalidateAll: jest.fn().mockResolvedValue(undefined),
    };
    const metricsService = { notificationFailuresTotal: { inc: jest.fn() } };
    const service = new NotificationEventService(
      writer as unknown as NotificationWriterService,
      emails as unknown as NotificationEmailService,
      reportCache as never,
      metricsService as never
    );

    const payload = {
      email: "buyer@example.com",
      customerName: "Buyer",
      bookingCode: "BK-DEDUP-TEST-2",
      eventTitle: "Event",
      eventLocation: "HCMC",
      eventDate: new Date(),
      zoneName: "VIP",
      seats: [],
      quantity: 1,
      totalPrice: 100000,
      currency: "vnd",
      tickets: [],
    };

    // Same millisecond is possible (two fast admin clicks) — the random
    // suffix, not just the timestamp, is what must guarantee no collision.
    await service.resendBookingConfirmationEmail(payload, "user-1");
    await service.resendBookingConfirmationEmail(payload, "user-1");

    const firstKey =
      emails.queueEmailNotification.mock.calls[0][0].metadata.idempotencyKey;
    const secondKey =
      emails.queueEmailNotification.mock.calls[1][0].metadata.idempotencyKey;

    expect(firstKey).not.toBe(secondKey);
  });
});
