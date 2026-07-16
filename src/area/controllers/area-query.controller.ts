import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { Roles } from "@src/common/decorators/roles.decorator";
import { RolesGuard } from "@src/guards/role.guard";
import { AreaQueryService } from "../application/area-query.service";
import { QueryAreaDto } from "../dto/query.dto";

@ApiTags("Area")
@Controller("area")
export class AreaQueryController {
  constructor(private readonly areaQueryService: AreaQueryService) {}

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get()
  getAllAreas(
    @Query() query: QueryAreaDto
  ): ReturnType<AreaQueryService["getAllAreas"]> {
    return this.areaQueryService.getAllAreas(query);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("/:id")
  getAreaById(
    @Param("id") id: string
  ): ReturnType<AreaQueryService["getAreaById"]> {
    return this.areaQueryService.getAreaById(id);
  }
}
