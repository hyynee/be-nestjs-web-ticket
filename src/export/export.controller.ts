import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ExportService } from "./export.service";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { ExportTicketDto } from "./dto/export-ticket.dto";
import { ExportCheckInDto } from "./dto/export-checkin.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import type { Response } from "express";

@ApiCookieAuth("access_token")
@Controller("export")
@Roles("admin")
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("tickets")
  exportTickets(
    @Query() query: ExportTicketDto,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response
  ) {
    return this.exportService.exportTickets(query, user.userId, res);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("checkin-zones")
  exportCheckInZones(
    @Query() query: ExportCheckInDto,
    @CurrentUser() user: JwtPayload,
    @Res() res: Response
  ) {
    return this.exportService.exportCheckInZones(query, user.userId, res);
  }
}
