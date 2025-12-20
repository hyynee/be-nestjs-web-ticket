import { Body, Controller, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { AreaService } from "./area.service";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { CreateAreaDTO } from "./dto/create.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { QueryAreaDto } from "./dto/query.dto";
import { UpdateAreaDTO } from "./dto/update.dto";

@ApiTags("Area")
@Controller("area")
export class AreaController {
  constructor(private readonly areaService: AreaService) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Post("/create")
  createArea(@CurrentUser() currentUser: JwtPayload,@Body() createAreaDto: CreateAreaDTO) {
    return this.areaService.createArea(currentUser,createAreaDto);
  }

  @Get()
  getAllAreas(@Query() query: QueryAreaDto) {
    return this.areaService.getAllAreas(query);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("/:id")
  updateArea(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() updateAreaDto: UpdateAreaDTO
  ) {
    return this.areaService.updateArea(currentUser, id, updateAreaDto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Get("/:id")
  getAreaById(@Param("id") id: string) {
    return this.areaService.getAreaById(id);
  }
}
