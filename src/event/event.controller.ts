import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { EventService } from "./event.service";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { CreateEventDTO } from "./dto/create-event.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";

@ApiTags("Event")
@Controller("event")
export class EventController {
  constructor(private readonly eventService: EventService) {}

  @Get()
  async getAllEvents() {
    return this.eventService.getAllActiveEvents();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Get("admin/all")
  async getAllEventsForAdmin() {
    return this.eventService.getAllEvents();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Get("admin/deleted")
  async getDeletedEvents() {
    return this.eventService.getDeletedEvents();
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Post("create")
  async createEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Body() CreateEventDTO: CreateEventDTO
  ) {
    return this.eventService.createEvent(currentUser, CreateEventDTO);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("update/:id")
  async updateEvent(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() updateEventDTO: UpdateEventDTO
  ) {
    return this.eventService.updateEvent(currentUser, id, updateEventDTO);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("delete/:id")
  async deleteEvent(@Param("id") id: string) {
    return this.eventService.deleteEvent(id);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("restore/:id")
  async restoreEvent(@Param("id") id: string) {
    return this.eventService.restoreEvent(id);
  }

  @Get(":id")
  async getEventById(@Param("id") id: string) {
    return this.eventService.getActiveEventById(id);
  }
}
