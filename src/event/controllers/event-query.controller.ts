import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { OptionalJwtAuthGuard } from "@src/guards/optional.guard";
import { RolesGuard } from "@src/guards/role.guard";
import { QueryEventDTO } from "../dto/query-event.dto";
import { EventQueryService } from "../application/event-query.service";

@ApiTags("Event")
@Controller("event")
export class EventQueryController {
  constructor(private readonly eventQueryService: EventQueryService) {}

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  getEvents(
    @Query() query: QueryEventDTO,
    @CurrentUser() user?: JwtPayload
  ): ReturnType<EventQueryService["getEvents"]> {
    return this.eventQueryService.getEvents(query, user);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(OptionalJwtAuthGuard)
  @Get(":id/zones")
  getEventZones(
    @Param("id") id: string,
    @CurrentUser() user?: JwtPayload
  ): ReturnType<EventQueryService["getEventZones"]> {
    return this.eventQueryService.getEventZones(id, user);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("admin/deleted")
  getDeletedEvents(): ReturnType<EventQueryService["getDeletedEvents"]> {
    return this.eventQueryService.getDeletedEvents();
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("my-managed-events")
  getMyManagedEvents(
    @CurrentUser() currentUser: JwtPayload,
    @Query() query: QueryEventDTO
  ): ReturnType<EventQueryService["getMyManagedEvents"]> {
    return this.eventQueryService.getMyManagedEvents(currentUser, query);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id")
  getEventById(
    @Param("id") id: string
  ): ReturnType<EventQueryService["getActiveEventById"]> {
    return this.eventQueryService.getActiveEventById(id);
  }
}
