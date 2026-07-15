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
import { Throttle } from "@nestjs/throttler";
import { AreaService } from "./area.service";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CreateAreaDTO } from "./dto/create.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { QueryAreaDto } from "./dto/query.dto";
import { SoftDeleteAreaDTO, UpdateAreaDTO } from "./dto/update.dto";

@ApiTags("Area")
@Controller("area")
export class AreaController {
  constructor(private readonly areaService: AreaService) {}

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("/create")
  createArea(
    @CurrentUser() currentUser: JwtPayload,
    @Body() createAreaDto: CreateAreaDTO
  ) {
    return this.areaService.createArea(currentUser, createAreaDto);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get()
  getAllAreas(@Query() query: QueryAreaDto) {
    return this.areaService.getAllAreas(query);
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
  ) {
    return this.areaService.softDeleteArea(currentUser, id, dto);
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
  ) {
    return this.areaService.updateArea(currentUser, id, dto);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("/:id")
  getAreaById(@Param("id") id: string) {
    return this.areaService.getAreaById(id);
  }
}
