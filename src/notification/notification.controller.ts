import {
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { QueryNotificationDto } from "./dto/query-notification.dto";
import { NotificationService } from "./notification.service";
import type {
  NotificationDetail,
  NotificationListResult,
  NotificationReadAllResult,
  NotificationReadResult,
  NotificationRetryResult,
  NotificationUnreadCountResult,
} from "./types/notification.types";

@ApiCookieAuth("access_token")
@ApiTags("notification")
@Controller()
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  @Get("notifications")
  @UseGuards(AuthGuard("jwt"))
  async listMyNotifications(
    @CurrentUser() user: JwtPayload,
    @Query() query: QueryNotificationDto
  ): Promise<NotificationListResult> {
    return this.notificationService.listForUser(user.userId, query);
  }

  @Get("notifications/unread-count")
  @UseGuards(AuthGuard("jwt"))
  async getUnreadCount(
    @CurrentUser() user: JwtPayload
  ): Promise<NotificationUnreadCountResult> {
    return this.notificationService.unreadCount(user.userId);
  }

  @Patch("notifications/:id/read")
  @HttpCode(200)
  @UseGuards(AuthGuard("jwt"))
  async markAsRead(
    @CurrentUser() user: JwtPayload,
    @Param("id") id: string
  ): Promise<NotificationReadResult> {
    return this.notificationService.markAsRead(user.userId, id);
  }

  @Patch("notifications/read-all")
  @HttpCode(200)
  @UseGuards(AuthGuard("jwt"))
  async markAllAsRead(
    @CurrentUser() user: JwtPayload
  ): Promise<NotificationReadAllResult> {
    return this.notificationService.markAllAsRead(user.userId);
  }

  @Get("admin/notifications")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async listAdminNotifications(
    @Query() query: QueryNotificationDto
  ): Promise<NotificationListResult> {
    return this.notificationService.listForAdmin(query);
  }

  @Get("admin/notifications/:id")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async getAdminNotification(
    @Param("id") id: string
  ): Promise<NotificationDetail> {
    return this.notificationService.getForAdmin(id);
  }

  @Post("admin/notifications/:id/retry")
  @HttpCode(200)
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  async retryNotification(
    @Param("id") id: string
  ): Promise<NotificationRetryResult> {
    return this.notificationService.retryEmail(id);
  }
}
