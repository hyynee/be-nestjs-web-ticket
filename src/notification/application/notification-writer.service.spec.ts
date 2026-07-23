import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import {
  NotificationChannel,
  NotificationType,
} from "@src/schemas/notification.schema";
import { NotificationWriterService } from "./notification-writer.service";

describe("NotificationWriterService", () => {
  function makeService(overrides: {
    createError?: unknown;
    existingByKey?: unknown;
  }) {
    const created = { _id: new Types.ObjectId(), title: "t", body: "b" };
    const repository = {
      create: overrides.createError
        ? jest.fn().mockRejectedValue(overrides.createError)
        : jest.fn().mockResolvedValue([created]),
      findByIdempotencyKey: jest
        .fn()
        .mockResolvedValue(overrides.existingByKey ?? null),
      toObjectId: jest.fn((id: string) => new Types.ObjectId(id)),
    };
    const presenter = {
      toDetail: jest.fn((row: unknown) => ({
        ...(row as object),
        presented: true,
      })),
    };
    const userModel = {
      findOne: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ _id: new Types.ObjectId() }),
      }),
    };
    const service = new NotificationWriterService(
      repository as never,
      presenter as never,
      userModel as never
    );
    return { service, repository, presenter, userModel, created };
  }

  it("creates a new notification on the first call", async () => {
    const { service, repository } = makeService({});

    await service.createNotification({
      userId: new Types.ObjectId().toString(),
      type: NotificationType.BOOKING_CREATED,
      channel: NotificationChannel.IN_APP,
      title: "  Booking created  ",
      body: "  body  ",
      metadata: { idempotencyKey: "booking-created:b1" },
    });

    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Booking created",
        body: "body",
        metadata: { idempotencyKey: "booking-created:b1" },
      })
    );
  });

  it("returns the existing record instead of creating a duplicate when idempotencyKey already exists (E11000)", async () => {
    const existing = { _id: new Types.ObjectId(), title: "existing" };
    const { service, repository } = makeService({
      createError: { code: 11000 },
      existingByKey: existing,
    });

    const result = await service.createNotification({
      userId: new Types.ObjectId().toString(),
      type: NotificationType.BOOKING_CREATED,
      channel: NotificationChannel.IN_APP,
      title: "Booking created",
      body: "body",
      metadata: { idempotencyKey: "booking-created:b1" },
    });

    expect(repository.findByIdempotencyKey).toHaveBeenCalledWith(
      "booking-created:b1"
    );
    expect(result).toEqual({ ...existing, presented: true });
  });

  it("re-throws the duplicate-key error if there is no idempotencyKey to look up by", async () => {
    const { service } = makeService({ createError: { code: 11000 } });

    await expect(
      service.createNotification({
        userId: new Types.ObjectId().toString(),
        type: NotificationType.BOOKING_CREATED,
        channel: NotificationChannel.IN_APP,
        title: "x",
        body: "x",
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("re-throws the duplicate-key error when no existing record can be found by that key", async () => {
    const { service } = makeService({
      createError: { code: 11000 },
      existingByKey: null,
    });

    await expect(
      service.createNotification({
        userId: new Types.ObjectId().toString(),
        type: NotificationType.BOOKING_CREATED,
        channel: NotificationChannel.IN_APP,
        title: "x",
        body: "x",
        metadata: { idempotencyKey: "k1" },
      })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("re-throws non-duplicate-key errors unchanged", async () => {
    const { service } = makeService({ createError: new Error("db down") });

    await expect(
      service.createNotification({
        userId: new Types.ObjectId().toString(),
        type: NotificationType.BOOKING_CREATED,
        channel: NotificationChannel.IN_APP,
        title: "x",
        body: "x",
      })
    ).rejects.toThrow("db down");
  });

  it("requires either userId or recipientEmail", async () => {
    const { service } = makeService({});

    await expect(
      service.createNotification({
        type: NotificationType.BOOKING_CREATED,
        channel: NotificationChannel.IN_APP,
        title: "x",
        body: "x",
      })
    ).rejects.toThrow(BadRequestException);
  });

  it("resolves userId by recipientEmail when userId is not given", async () => {
    const { service, userModel, repository } = makeService({});

    await service.createNotification({
      recipientEmail: "USER@Example.com",
      type: NotificationType.BOOKING_CREATED,
      channel: NotificationChannel.EMAIL,
      title: "x",
      body: "x",
    });

    expect(userModel.findOne).toHaveBeenCalledWith({
      email: "user@example.com",
    });
    expect(repository.create).toHaveBeenCalled();
  });

  it("throws NotFoundException when resolving userId by an unknown email", async () => {
    const { service, userModel } = makeService({});
    userModel.findOne.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(null),
    });

    await expect(
      service.createNotification({
        recipientEmail: "nobody@example.com",
        type: NotificationType.BOOKING_CREATED,
        channel: NotificationChannel.EMAIL,
        title: "x",
        body: "x",
      })
    ).rejects.toThrow(NotFoundException);
  });
});
