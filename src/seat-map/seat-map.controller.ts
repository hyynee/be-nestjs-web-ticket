import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiCookieAuth, ApiTags } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { Throttle } from "@nestjs/throttler";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { SeatMapService } from "./seat-map.service";
import { BlockSeatsDto } from "./dto/block-seats.dto";
import { UnblockSeatsDto } from "./dto/unblock-seats.dto";

// Seat maps are public read data (a visitor picks seats before logging in),
// so these two live on the existing public "event"/"zone" prefixes without
// an auth guard, same as event/zone browsing endpoints.

@ApiTags("SeatMap")
@Controller("event")
export class EventSeatMapController {
  constructor(private readonly seatMapService: SeatMapService) {}

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id/seat-map")
  getEventSeatMap(
    @Param("id") id: string
  ): ReturnType<SeatMapService["getEventSeatMap"]> {
    return this.seatMapService.getEventSeatMap(id);
  }
}

@ApiTags("SeatMap")
@Controller("zone")
export class ZoneSeatMapController {
  constructor(private readonly seatMapService: SeatMapService) {}

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get(":id/seat-map")
  getZoneSeatMap(
    @Param("id") id: string
  ): ReturnType<SeatMapService["getZoneSeatMap"]> {
    return this.seatMapService.getZoneSeatMap(id);
  }
}

@ApiTags("SeatMap")
@Controller("seat-map")
export class SeatMapController {
  constructor(private readonly seatMapService: SeatMapService) {}

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("block")
  blockSeats(
    @CurrentUser() user: JwtPayload,
    @Body() dto: BlockSeatsDto
  ): ReturnType<SeatMapService["blockSeats"]> {
    return this.seatMapService.blockSeats(user, dto);
  }

  @Throttle({ short: { limit: 20, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Post("unblock")
  unblockSeats(
    @CurrentUser() user: JwtPayload,
    @Body() dto: UnblockSeatsDto
  ): ReturnType<SeatMapService["unblockSeats"]> {
    return this.seatMapService.unblockSeats(user, dto);
  }
}
