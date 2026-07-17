import { Injectable, NotFoundException } from "@nestjs/common";
import type {
  NotificationReadAllResult,
  NotificationReadResult,
} from "../types/notification.types";
import { NotificationRepository } from "../infrastructure/persistence/notification.repository";

@Injectable()
export class NotificationReadService {
  constructor(private readonly repository: NotificationRepository) {}

  async markAsRead(
    userId: string,
    id: string
  ): Promise<NotificationReadResult> {
    const notificationId = this.repository.toObjectId(
      id,
      "Invalid notification ID"
    );
    const updated = await this.repository.markUserNotificationRead(
      userId,
      notificationId
    );

    if (!updated) {
      throw new NotFoundException("Notification not found");
    }

    return { id: updated._id.toString(), read: true };
  }

  async markAllAsRead(userId: string): Promise<NotificationReadAllResult> {
    const modifiedCount =
      await this.repository.markAllUserNotificationsRead(userId);
    return { modifiedCount };
  }
}
