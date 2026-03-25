import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from "@nestjs/common";
import { EventService } from "./event.service";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { CreateEventDTO } from "./dto/create-event.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { OptionalJwtAuthGuard } from "@src/guards/optional.guard";
import { Throttle } from "@nestjs/throttler";

@ApiTags("Event")
@Controller("event")
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  getEvents(@Query() query: QueryEventDTO, @CurrentUser() user?: JwtPayload) {
    return this.eventService.getEvents(query, user);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(OptionalJwtAuthGuard)
  @Get(":id/zones")
  getEventZones(@Param("id") id: string, @CurrentUser() user?: JwtPayload) {
    return this.eventService.getEventZones(id, user);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Get("admin/deleted")
  async getDeletedEvents() {
    return this.eventService.getDeletedEvents();
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id")
  async getEventById(@Param("id") id: string) {
    return this.eventService.getActiveEventById(id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Post("create")
  async createEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Body() CreateEventDTO: CreateEventDTO
  ) {
    return this.eventService.createEvent(currentUser, CreateEventDTO);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("update/:id")
  async updateEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() updateEventDTO: UpdateEventDTO
  ) {
    return this.eventService.updateEvent(currentUser, id, updateEventDTO);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("delete/:id")
  async deleteEvent(@Param("id") id: string) {
    return this.eventService.deleteEvent(id);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("restore/:id")
  async restoreEvent(@Param("id") id: string) {
    return this.eventService.restoreEvent(id);
  }
}
