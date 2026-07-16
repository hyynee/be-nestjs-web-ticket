import { Body, Controller, Param, Post, Put, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { AreaCommandService } from "../application/area-command.service";
import { CreateAreaDTO } from "../dto/create.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "../dto/update.dto";

@ApiTags("Area")
@Controller("area")
export class AreaManagementController {
  constructor(private readonly areaCommandService: AreaCommandService) {}

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("/create")
  createArea(
    @CurrentUser() currentUser: JwtPayload,
    @Body() createAreaDto: CreateAreaDTO
  ): ReturnType<AreaCommandService["createArea"]> {
    return this.areaCommandService.createArea(currentUser, createAreaDto);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Put("/:id/delete")
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  softDeleteArea(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: SoftDeleteAreaDTO
  ): ReturnType<AreaCommandService["softDeleteArea"]> {
    return this.areaCommandService.softDeleteArea(currentUser, id, dto);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @Put("/:id")
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  updateArea(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() dto: UpdateAreaDTO
  ): ReturnType<AreaCommandService["updateArea"]> {
    return this.areaCommandService.updateArea(currentUser, id, dto);
  }
}
