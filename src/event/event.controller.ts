import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import { Roles } from "@src/common/decorators/roles.decorator";
import { CreateEventDTO } from "./dto/create-event.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { CancelEventDto } from "./dto/cancel-event.dto";
import { AssignOrganizerDto } from "./dto/assign-organizer.dto";
import { AssignStaffDto } from "./dto/assign-staff.dto";
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
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("admin/deleted")
  async getDeletedEvents() {
    return this.eventService.getDeletedEvents();
  }

  // Must stay ahead of `@Get(":id")` below — both are single-segment GET
  // routes under /event, and Nest/Express match in registration order.
  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("my-managed-events")
  async getMyManagedEvents(
    @CurrentUser() currentUser: JwtPayload,
    @Query() query: QueryEventDTO
  ) {
    return this.eventService.getMyManagedEvents(currentUser, query);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id")
  async getEventById(@Param("id") id: string) {
    return this.eventService.getActiveEventById(id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("create")
  async createEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Body() CreateEventDTO: CreateEventDTO
  ) {
    return this.eventService.createEvent(currentUser, CreateEventDTO);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("update/:id")
  async updateEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() updateEventDTO: UpdateEventDTO
  ) {
    return this.eventService.updateEvent(currentUser, id, updateEventDTO);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post(":id/organizers")
  async assignOrganizer(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: AssignOrganizerDto
  ) {
    return this.eventService.addOrganizerToEvent(currentUser, id, dto.userId);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Delete(":id/organizers/:userId")
  async removeOrganizer(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Param("userId") userId: string
  ) {
    return this.eventService.removeOrganizerFromEvent(currentUser, id, userId);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get(":id/staff")
  async getEventStaff(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ) {
    return this.eventService.getEventStaff(currentUser, id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post(":id/staff")
  async assignStaff(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: AssignStaffDto
  ) {
    return this.eventService.addStaffToEvent(
      currentUser,
      id,
      dto.userId,
      dto.notes
    );
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Delete(":id/staff/:userId")
  async removeStaff(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Param("userId") userId: string
  ) {
    return this.eventService.removeStaffFromEvent(currentUser, id, userId);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("delete/:id")
  async deleteEvent(@Param("id") id: string) {
    return this.eventService.deleteEvent(id);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("restore/:id")
  async restoreEvent(@Param("id") id: string) {
    return this.eventService.restoreEvent(id);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Post(":id/cancel")
  async cancelEvent(
    @Param("id") id: string,
    @CurrentUser() admin: JwtPayload,
    @Body() dto: CancelEventDto
  ) {
    return this.eventService.cancelEventWithRefund(
      id,
      admin.userId,
      dto.reason
    );
  }
}
