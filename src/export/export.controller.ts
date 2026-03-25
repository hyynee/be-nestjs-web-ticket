import { Controller, Get, Query, Res, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ExportService } from "./export.service";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { ExportTicketDto } from "./dto/export-ticket.dto";
import type { Response } from "express";
import { ExportCheckInDto } from "./dto/export-checkin.dto";
@ApiCookieAuth("access_token")
@Controller("export")
@UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("tickets")
  exportTickets(@Query() query: ExportTicketDto, @Res() res: Response) {
    return this.exportService.exportTickets(query, res);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("checkin-zones")
  exportCheckInZones(@Query() query: ExportCheckInDto, @Res() res: Response) {
    return this.exportService.exportCheckInZones(query, res);
  }
}
