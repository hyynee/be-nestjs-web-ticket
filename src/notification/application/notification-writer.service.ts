import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { User } from "@src/schemas/user.schema";
import {
  NotificationChannel,
  NotificationStatus,
} from "@src/schemas/notification.schema";
import { Model, Types } from "mongoose";
import { NotificationPresenter } from "../notification.presenter";
import { NotificationMetadata } from "../types/notification.types";
import type { NotificationDetail } from "../types/notification.types";
import type { NotificationDocument } from "../domain/types/notification-domain.types";
import { NotificationRepository } from "../infrastructure/persistence/notification.repository";

export type NotificationCreateInput = {
  userId?: string | Types.ObjectId;
  recipientEmail?: string;
  type: import("@src/schemas/notification.schema").NotificationType;
  channel: NotificationChannel;
  title: string;
  body: string;
  metadata?: NotificationMetadata;
  status?: NotificationStatus;
};

@Injectable()
export class NotificationWriterService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly presenter: NotificationPresenter,
    @InjectModel(User.name) private readonly userModel: Model<User>
  ) {}

  async createNotification(
    input: NotificationCreateInput
  ): Promise<NotificationDetail> {
    const userId = await this.resolveUserId(input.userId, input.recipientEmail);
    const metadata = this.compactMetadata(input.metadata);

    try {
      const [created] = await this.repository.create({
        userId,
        type: input.type,
        channel: input.channel,
        title: input.title.trim(),
        body: input.body.trim(),
        status: input.status ?? NotificationStatus.QUEUED,
        recipientEmail: input.recipientEmail?.trim().toLowerCase(),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
      return this.presenter.toDetail(created as NotificationDocument);
    } catch (error) {
      const idempotencyKey = metadata.idempotencyKey;
      if (
        this.isDuplicateKeyError(error) &&
        typeof idempotencyKey === "string"
      ) {
        const existing =
          await this.repository.findByIdempotencyKey(idempotencyKey);
        if (existing) {
          return this.presenter.toDetail(existing);
        }
      }
      throw error;
    }
  }

  async resolveUserIdByEmail(email: string): Promise<string> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.userModel
      .findOne({ email: normalizedEmail })
      .select("_id")
      .lean<{ _id: Types.ObjectId }>();
    if (!user) {
      throw new NotFoundException("Notification recipient user not found");
    }
    return user._id.toString();
  }

  private async resolveUserId(
    userId?: string | Types.ObjectId,
    recipientEmail?: string
  ): Promise<Types.ObjectId> {
    if (userId) {
      return userId instanceof Types.ObjectId
        ? userId
        : this.repository.toObjectId(userId, "Invalid user ID");
    }
    if (!recipientEmail) {
      throw new BadRequestException("Notification userId is required");
    }
    return new Types.ObjectId(await this.resolveUserIdByEmail(recipientEmail));
  }

  private compactMetadata(
    metadata?: NotificationMetadata
  ): Record<string, unknown> {
    if (!metadata) return {};
    return Object.fromEntries(
      Object.entries(metadata).filter(([, value]) => value !== undefined)
    );
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: number }).code === 11000
    );
  }
}
