import { Injectable } from "@nestjs/common";
import { FilterQuery, Types } from "mongoose";
import {
  Notification,
  NotificationChannel,
  NotificationStatus,
} from "@src/schemas/notification.schema";
import { QueryNotificationDto } from "../dto/query-notification.dto";
import { NotificationRepository } from "../infrastructure/persistence/notification.repository";
import { NotificationPresenter } from "../notification.presenter";
import type {
  NotificationDetail,
  NotificationListResult,
  NotificationUnreadCountResult,
} from "../types/notification.types";

@Injectable()
export class NotificationQueryService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly presenter: NotificationPresenter
  ) {}

  async listForUser(
    userId: string,
    query: QueryNotificationDto
  ): Promise<NotificationListResult> {
    const filter = this.buildFilter(query);
    filter.userId = new Types.ObjectId(userId);
    return this.findMany(filter, query.page, query.limit);
  }

  async unreadCount(userId: string): Promise<NotificationUnreadCountResult> {
    const unreadCount = await this.repository.count({
      userId: new Types.ObjectId(userId),
      channel: NotificationChannel.IN_APP,
      status: { $ne: NotificationStatus.READ },
    });
    return { unreadCount };
  }

  async listForAdmin(
    query: QueryNotificationDto
  ): Promise<NotificationListResult> {
    return this.findMany(this.buildFilter(query), query.page, query.limit);
  }

  async getForAdmin(id: string): Promise<NotificationDetail> {
    const notification = await this.repository.loadById(id);
    return this.presenter.toDetail(notification);
  }

  private async findMany(
    filter: FilterQuery<Notification>,
    page: number,
    limit: number
  ): Promise<NotificationListResult> {
    const { rows, total } = await this.repository.findMany(filter, page, limit);
    return {
      items: rows.map((row) => this.presenter.toDetail(row)),
      total,
      page,
      limit,
    };
  }

  private buildFilter(query: QueryNotificationDto): FilterQuery<Notification> {
    const filter: FilterQuery<Notification> = {};
    if (query.channel) filter.channel = query.channel;
    if (query.status) filter.status = query.status;
    if (query.type) filter.type = query.type;
    if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    if (query.idempotencyKey) {
      filter["metadata.idempotencyKey"] = query.idempotencyKey.trim();
    }
    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }
    return filter;
  }
}
