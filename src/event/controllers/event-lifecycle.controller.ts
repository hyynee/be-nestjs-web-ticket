import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { CancelEventDto } from "../dto/cancel-event.dto";
import { EventLifecycleService } from "../application/event-lifecycle.service";

@ApiTags("Event")
@Controller("event")
export class EventLifecycleController {
  constructor(private readonly eventLifecycleService: EventLifecycleService) {}

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Post(":id/publish")
  publishEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ): ReturnType<EventLifecycleService["publishEvent"]> {
    return this.eventLifecycleService.publishEvent(currentUser, id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Post(":id/unpublish")
  unpublishEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ): ReturnType<EventLifecycleService["unpublishEvent"]> {
    return this.eventLifecycleService.unpublishEvent(currentUser, id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Post(":id/end")
  endEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ): ReturnType<EventLifecycleService["endEvent"]> {
    return this.eventLifecycleService.endEvent(currentUser, id);
  }

  /**
   * Async contract — see docs/API_CHANGELOG.md ("Event cancellation is now
   * async") for the full response shape and migration history. Returns a
   * job handle immediately; poll getCancellationStatus below for progress.
   */
  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Post(":id/cancel")
  cancelEvent(
    @Param("id") id: string,
    @CurrentUser() admin: JwtPayload,
    @Body() dto: CancelEventDto
  ): ReturnType<EventLifecycleService["cancelEventWithRefund"]> {
    return this.eventLifecycleService.cancelEventWithRefund(
      id,
      admin.userId,
      dto.reason
    );
  }

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get(":id/cancel-status")
  getCancellationStatus(
    @Param("id") id: string
  ): ReturnType<EventLifecycleService["getCancellationStatus"]> {
    return this.eventLifecycleService.getCancellationStatus(id);
  }
}
