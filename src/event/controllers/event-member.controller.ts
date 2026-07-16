import {
  Body,
  Controller,
  Delete,
  Get,
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
import { AssignOrganizerDto } from "../dto/assign-organizer.dto";
import { AssignStaffDto } from "../dto/assign-staff.dto";
import { EventMemberService } from "../application/event-member.service";

@ApiTags("Event")
@Controller("event")
export class EventMemberController {
  constructor(private readonly eventMemberService: EventMemberService) {}

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post(":id/organizers")
  addOrganizer(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: AssignOrganizerDto
  ): ReturnType<EventMemberService["addOrganizerToEvent"]> {
    return this.eventMemberService.addOrganizerToEvent(
      currentUser,
      id,
      dto.userId
    );
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Delete(":id/organizers/:userId")
  removeOrganizer(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Param("userId") userId: string
  ): ReturnType<EventMemberService["removeOrganizerFromEvent"]> {
    return this.eventMemberService.removeOrganizerFromEvent(
      currentUser,
      id,
      userId
    );
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get(":id/staff")
  getEventStaff(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string
  ): ReturnType<EventMemberService["getEventStaff"]> {
    return this.eventMemberService.getEventStaff(currentUser, id);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post(":id/staff")
  addStaff(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: AssignStaffDto
  ): ReturnType<EventMemberService["addStaffToEvent"]> {
    return this.eventMemberService.addStaffToEvent(
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
  removeStaff(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Param("userId") userId: string
  ): ReturnType<EventMemberService["removeStaffFromEvent"]> {
    return this.eventMemberService.removeStaffFromEvent(
      currentUser,
      id,
      userId
    );
  }
}
