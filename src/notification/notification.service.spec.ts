import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Types } from "mongoose";
import {
  NotificationChannel,
  NotificationStatus,
  NotificationType,
} from "@src/schemas/notification.schema";
import { NotificationPresenter } from "./notification.presenter";
import { NotificationService } from "./notification.service";
import { NotificationEmailService } from "./application/notification-email.service";
import { NotificationEventService } from "./application/notification-event.service";
import { NotificationQueryService } from "./application/notification-query.service";
import { NotificationReadService } from "./application/notification-read.service";
import { NotificationWriterService } from "./application/notification-writer.service";
import { NotificationRepository } from "./infrastructure/persistence/notification.repository";

describe("NotificationService", () => {
  const userId = new Types.ObjectId();
  const notificationId = new Types.ObjectId();

  let notificationModel: {
    find: jest.Mock;
    countDocuments: jest.Mock;
    findOneAndUpdate: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
    updateOne: jest.Mock;
    findById: jest.Mock;
    findOne: jest.Mock;
  };
  let userModel: { findOne: jest.Mock; findById: jest.Mock };
  let queueService: { addJob: jest.Mock; retryJob: jest.Mock };
  let mailService: { deliverNotificationEmail: jest.Mock };
  let service: NotificationService;

  const mockFindChain = <T>(rows: T) => ({
    sort: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(rows),
  });

  const mockLeanChain = <T>(value: T) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(value),
  });

  const baseNotification = {
    _id: notificationId,
    userId,
    type: NotificationType.BOOKING_CREATED,
    channel: NotificationChannel.IN_APP,
    title: "Booking created",
    body: "BK001",
    status: NotificationStatus.SENT,
    createdAt: new Date("2026-07-17T00:00:00.000Z"),
    updatedAt: new Date("2026-07-17T00:00:00.000Z"),
  };

  beforeEach(() => {
    notificationModel = {
      find: jest.fn(),
      countDocuments: jest.fn(),
      findOneAndUpdate: jest.fn(),
      updateMany: jest.fn(),
      create: jest.fn(),
      updateOne: jest.fn(),
      findById: jest.fn(),
      findOne: jest.fn(),
    };
    userModel = {
      findOne: jest.fn(),
      findById: jest.fn(),
    };
    queueService = {
      addJob: jest.fn().mockResolvedValue({ id: "job-1" }),
      retryJob: jest.fn().mockResolvedValue({ id: "job-1", retried: true }),
    };
    mailService = {
      deliverNotificationEmail: jest.fn().mockResolvedValue(undefined),
    };

    const presenter = new NotificationPresenter();
    const repository = new NotificationRepository(notificationModel as never);
    const writer = new NotificationWriterService(
      repository,
      presenter,
      userModel as never
    );
    const query = new NotificationQueryService(repository, presenter);
    const read = new NotificationReadService(repository);
    const email = new NotificationEmailService(
      repository,
      writer,
      queueService as never,
      mailService as never,
      userModel as never
    );
    const events = new NotificationEventService(writer, email);
    service = new NotificationService(query, read, email, events, {} as never);
  });

  it("lists only notifications for the requesting user", async () => {
    notificationModel.find.mockReturnValue(mockFindChain([baseNotification]));
    notificationModel.countDocuments.mockResolvedValue(1);

    const result = await service.listForUser(userId.toString(), {
      page: 1,
      limit: 20,
    });

    expect(notificationModel.find).toHaveBeenCalledWith({
      userId,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe(notificationId.toString());
  });

  it("counts only unread in-app notifications", async () => {
    notificationModel.countDocuments.mockResolvedValue(3);

    const result = await service.unreadCount(userId.toString());

    expect(notificationModel.countDocuments).toHaveBeenCalledWith({
      userId,
      channel: NotificationChannel.IN_APP,
      status: { $ne: NotificationStatus.READ },
    });
    expect(result).toEqual({ unreadCount: 3 });
  });

  it("marks a user-owned in-app notification as read", async () => {
    notificationModel.findOneAndUpdate.mockReturnValue(
      mockLeanChain({
        ...baseNotification,
        status: NotificationStatus.READ,
        readAt: new Date("2026-07-17T01:00:00.000Z"),
      })
    );

    const result = await service.markAsRead(
      userId.toString(),
      notificationId.toString()
    );

    expect(notificationModel.findOneAndUpdate).toHaveBeenCalledWith(
      {
        _id: notificationId,
        userId,
        channel: NotificationChannel.IN_APP,
      },
      {
        $set: { status: NotificationStatus.READ, readAt: expect.any(Date) },
      },
      { new: true }
    );
    expect(result).toEqual({ id: notificationId.toString(), read: true });
  });

  it("throws when marking a notification that does not belong to the user", async () => {
    notificationModel.findOneAndUpdate.mockReturnValue(mockLeanChain(null));

    await expect(
      service.markAsRead(userId.toString(), notificationId.toString())
    ).rejects.toThrow(NotFoundException);
  });

  it("creates an email notification and enqueues the delivery job", async () => {
    notificationModel.create.mockResolvedValue([
      {
        ...baseNotification,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.QUEUED,
        recipientEmail: "user@example.com",
        metadata: { template: "generic" },
      },
    ]);

    const result = await service.queueEmailNotification({
      userId,
      recipientEmail: "user@example.com",
      type: NotificationType.EVENT_REMINDER,
      title: "Reminder",
      body: "Event soon",
      template: "generic",
      payload: {
        to: "user@example.com",
        title: "Reminder",
        body: "Event soon",
      },
    });

    expect(queueService.addJob).toHaveBeenCalledWith(
      {
        type: "send-notification-email",
        payload: {
          notificationId: result.id,
          template: "generic",
          payload: {
            to: "user@example.com",
            title: "Reminder",
            body: "Event soon",
          },
        },
        requestedAt: expect.any(String),
      },
      { jobId: `send-notification-email-${result.id}` }
    );
    expect(result.status).toBe(NotificationStatus.QUEUED);
  });

  it("marks queued email as failed when delivery throws", async () => {
    notificationModel.findById.mockReturnValue(
      mockLeanChain({
        ...baseNotification,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.QUEUED,
      })
    );
    mailService.deliverNotificationEmail.mockRejectedValue(
      new Error("SMTP down")
    );

    await expect(
      service.deliverQueuedEmail(notificationId.toString(), "generic", {
        to: "user@example.com",
        title: "Reminder",
        body: "Event soon",
      })
    ).rejects.toThrow("SMTP down");

    expect(notificationModel.updateOne).toHaveBeenCalledWith(
      { _id: notificationId },
      {
        $set: {
          status: NotificationStatus.FAILED,
          errorMessage: "SMTP down",
        },
      }
    );
  });

  it("rejects retry for non-email notifications", async () => {
    notificationModel.findById.mockReturnValue(mockLeanChain(baseNotification));

    await expect(service.retryEmail(notificationId.toString())).rejects.toThrow(
      BadRequestException
    );
  });

  it("re-enqueues a failed register email when the original queue job is missing", async () => {
    notificationModel.findById.mockReturnValue(
      mockLeanChain({
        ...baseNotification,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.FAILED,
        recipientEmail: "user@example.com",
        metadata: { template: "register" },
      })
    );
    notificationModel.findOneAndUpdate.mockReturnValue(
      mockLeanChain({
        ...baseNotification,
        channel: NotificationChannel.EMAIL,
        status: NotificationStatus.QUEUED,
        recipientEmail: "user@example.com",
        metadata: { template: "register" },
      })
    );
    queueService.retryJob.mockRejectedValue(new NotFoundException("missing"));
    userModel.findById.mockReturnValue(
      mockLeanChain({ fullName: "Ticket User" })
    );

    const result = await service.retryEmail(notificationId.toString());

    expect(queueService.retryJob).toHaveBeenCalledWith(
      `send-notification-email-${notificationId.toString()}`
    );
    expect(queueService.addJob).toHaveBeenCalledWith(
      {
        type: "send-notification-email",
        payload: {
          notificationId: notificationId.toString(),
          template: "register",
          payload: {
            to: "user@example.com",
            fullName: "Ticket User",
          },
        },
        requestedAt: expect.any(String),
      },
      { jobId: `send-notification-email-${notificationId.toString()}` }
    );
    expect(result).toEqual({
      id: notificationId.toString(),
      status: NotificationStatus.QUEUED,
    });
  });
});
