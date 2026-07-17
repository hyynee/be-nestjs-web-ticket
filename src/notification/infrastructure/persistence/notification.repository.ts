import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import {
  Notification,
  NotificationChannel,
  NotificationStatus,
} from "@src/schemas/notification.schema";
import { FilterQuery, Model, Types } from "mongoose";
import type { NotificationDocument } from "../../domain/types/notification-domain.types";

@Injectable()
export class NotificationRepository {
  constructor(
    @InjectModel(Notification.name)
    private readonly notificationModel: Model<Notification>
  ) {}

  count(filter: FilterQuery<Notification>): Promise<number> {
    return this.notificationModel.countDocuments(filter);
  }

  async findMany(
    filter: FilterQuery<Notification>,
    page: number,
    limit: number
  ): Promise<{ rows: NotificationDocument[]; total: number }> {
    const skip = (page - 1) * limit;
    const [rows, total] = await Promise.all([
      this.notificationModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<NotificationDocument[]>(),
      this.notificationModel.countDocuments(filter),
    ]);
    return { rows, total };
  }

  async loadById(id: string): Promise<NotificationDocument> {
    const notificationId = this.toObjectId(id, "Invalid notification ID");
    const notification = await this.notificationModel
      .findById(notificationId)
      .lean<NotificationDocument>();
    if (!notification) {
      throw new NotFoundException("Notification not found");
    }
    return notification;
  }

  create(input: Partial<Notification>): Promise<Notification[]> {
    return this.notificationModel.create([input]);
  }

  findByIdempotencyKey(
    idempotencyKey: string
  ): Promise<NotificationDocument | null> {
    return this.notificationModel
      .findOne({ "metadata.idempotencyKey": idempotencyKey })
      .lean<NotificationDocument>();
  }

  markUserNotificationRead(
    userId: string,
    notificationId: Types.ObjectId
  ): Promise<NotificationDocument | null> {
    return this.notificationModel
      .findOneAndUpdate(
        {
          _id: notificationId,
          userId: new Types.ObjectId(userId),
          channel: NotificationChannel.IN_APP,
        },
        {
          $set: { status: NotificationStatus.READ, readAt: new Date() },
        },
        { new: true }
      )
      .lean<NotificationDocument>();
  }

  async markAllUserNotificationsRead(userId: string): Promise<number> {
    const result = await this.notificationModel.updateMany(
      {
        userId: new Types.ObjectId(userId),
        channel: NotificationChannel.IN_APP,
        status: { $ne: NotificationStatus.READ },
      },
      { $set: { status: NotificationStatus.READ, readAt: new Date() } }
    );
    return result.modifiedCount;
  }

  updateOne(
    filter: FilterQuery<Notification>,
    update: Record<string, unknown>
  ): Promise<unknown> {
    return this.notificationModel.updateOne(filter, update);
  }

  findOneAndUpdate(
    filter: FilterQuery<Notification>,
    update: Record<string, unknown>
  ): Promise<NotificationDocument | null> {
    return this.notificationModel
      .findOneAndUpdate(filter, update, { new: true })
      .lean<NotificationDocument>();
  }

  toObjectId(value: string, message: string): Types.ObjectId {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(message);
    }
    return new Types.ObjectId(value);
  }
}
