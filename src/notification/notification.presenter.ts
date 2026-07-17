import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { Notification } from "@src/schemas/notification.schema";
import type {
  NotificationDetail,
  NotificationMetadata,
} from "./types/notification.types";

export type NotificationViewSource = Notification & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

@Injectable()
export class NotificationPresenter {
  toDetail(notification: NotificationViewSource): NotificationDetail {
    return {
      id: notification._id.toString(),
      userId: notification.userId.toString(),
      type: notification.type,
      channel: notification.channel,
      title: notification.title,
      body: notification.body,
      status: notification.status,
      ...(notification.recipientEmail
        ? { recipientEmail: notification.recipientEmail }
        : {}),
      ...(notification.metadata
        ? { metadata: notification.metadata as NotificationMetadata }
        : {}),
      ...(notification.sentAt
        ? { sentAt: notification.sentAt.toISOString() }
        : {}),
      ...(notification.readAt
        ? { readAt: notification.readAt.toISOString() }
        : {}),
      ...(notification.errorMessage
        ? { errorMessage: notification.errorMessage }
        : {}),
      ...(notification.createdAt
        ? { createdAt: notification.createdAt.toISOString() }
        : {}),
      ...(notification.updatedAt
        ? { updatedAt: notification.updatedAt.toISOString() }
        : {}),
    };
  }
}
