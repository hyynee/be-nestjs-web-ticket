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
import { ZoneService } from "./zone.service";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { QueryZoneDto } from "./dto/query-zone.dto";
import { CreateZoneDto } from "./dto/create-zone.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { UpdateZoneDto } from "./dto/update-zone.dto";

@ApiTags("Zone")
@Controller("zone")
export class ZoneController {
  constructor(private readonly zoneService: ZoneService) { }

  @Get()
  async getAllZones(@Query() query: QueryZoneDto) {
    return this.zoneService.getAllActiveZones(query);
  }

  @Get(":id")
  @ApiOperation({ summary: "Lấy thông tin khu vực theo ID" })
  async getZoneActiveById(@Param("id") id: string) {
    return this.zoneService.getZoneById(id);
  }

  @Get(":id/with-areas")
  async getZoneWithAreas(@Param("id") zoneId: string) {
    return this.zoneService.getZoneWithAreas(zoneId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Post("")
  @ApiOperation({ summary: "Tạo khu vực mới" })
  async createZone(
    @CurrentUser() currentUser: JwtPayload,
    @Body() createZoneDto: CreateZoneDto
  ) {
    return this.zoneService.createZone(currentUser, createZoneDto);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @Put("update/:id")
  @ApiOperation({ summary: "Cập nhật thông tin khu vực" })
  async updateZone(
    @CurrentUser() currentUser: JwtPayload,
    @Param("id") id: string,
    @Body() updateZoneDto: UpdateZoneDto
  ) {
    return this.zoneService.updateZone(currentUser, id, updateZoneDto);
  }


}
