import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Query,
  UseGuards,
} from "@nestjs/common";
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

@ApiCookieAuth("access_token")
@Controller("export")
@Roles("admin", "organizer")
@UseGuards(AuthGuard("jwt"), RolesGuard)
export class ExportController {
  constructor(private readonly exportService: ExportService) {}

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("tickets")
  @HttpCode(HttpStatus.ACCEPTED)
  exportTickets(
    @Query() query: ExportTicketDto,
    @CurrentUser() user: JwtPayload
  ): ReturnType<ExportService["exportTickets"]> {
    return this.exportService.exportTickets(query, user);
  }

  @Throttle({ short: { limit: 5, ttl: 60000 } })
  @Get("checkin-zones")
  @HttpCode(HttpStatus.ACCEPTED)
  exportCheckInZones(
    @Query() query: ExportCheckInDto,
    @CurrentUser() user: JwtPayload
  ): ReturnType<ExportService["exportCheckInZones"]> {
    return this.exportService.exportCheckInZones(query, user);
  }
}
