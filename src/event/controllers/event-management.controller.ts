import { Body, Controller, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { CreateEventDTO } from "../dto/create-event.dto";
import { UpdateEventDTO } from "../dto/update-event.dto";
import { EventCommandService } from "../application/event-command.service";

@ApiTags("Event")
@Controller("event")
export class EventManagementController {
  constructor(private readonly eventCommandService: EventCommandService) {}

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("create")
  createEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: CreateEventDTO
  ): ReturnType<EventCommandService["createEvent"]> {
    return this.eventCommandService.createEvent(currentUser, dto);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("update/:id")
  updateEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: UpdateEventDTO
  ): ReturnType<EventCommandService["updateEvent"]> {
    return this.eventCommandService.updateEvent(currentUser, id, dto);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("delete/:id")
  deleteEvent(
    @Param("id") id: string
  ): ReturnType<EventCommandService["deleteEvent"]> {
    return this.eventCommandService.deleteEvent(id);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("restore/:id")
  restoreEvent(
    @Param("id") id: string
  ): ReturnType<EventCommandService["restoreEvent"]> {
    return this.eventCommandService.restoreEvent(id);
  }
}
