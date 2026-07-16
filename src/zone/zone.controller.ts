import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Body,
  UseGuards,
  Put,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ZoneService } from "./zone.service";
import { ApiCookieAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { QueryZoneDto } from "./dto/query-zone.dto";
import { CreateZoneDto } from "./dto/create-zone.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { UpdateZoneDto } from "./dto/update-zone.dto";

@ApiTags("Zone")
@Controller("zone")
export class ZoneController {
  constructor(private readonly zoneService: ZoneService) {}

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get()
  async getAllZones(
    @Query() query: QueryZoneDto
  ): ReturnType<ZoneService["getAllActiveZones"]> {
    return this.zoneService.getAllActiveZones(query);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id")
  @ApiOperation({ summary: "Lấy thông tin khu vực theo ID" })
  async getZoneActiveById(
    @Param("id") id: string
  ): ReturnType<ZoneService["getZoneById"]> {
    return this.zoneService.getZoneById(id);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id/with-areas")
  async getZoneWithAreas(
    @Param("id") zoneId: string
  ): ReturnType<ZoneService["getZoneWithAreas"]> {
    return this.zoneService.getZoneWithAreas(zoneId);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("")
  @ApiOperation({ summary: "Tạo khu vực mới" })
  async createZone(
    @CurrentUser() currentUser: JwtPayload,
    @Body() createZoneDto: CreateZoneDto
  ): ReturnType<ZoneService["createZone"]> {
    return this.zoneService.createZone(currentUser, createZoneDto);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Put("update/:id")
  @ApiOperation({ summary: "Cập nhật thông tin khu vực" })
  async updateZone(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() updateZoneDto: UpdateZoneDto
  ): ReturnType<ZoneService["updateZone"]> {
    return this.zoneService.updateZone(currentUser, id, updateZoneDto);
  }
}
