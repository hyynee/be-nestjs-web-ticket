import { Controller, Get, HttpCode, Param, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BookingService } from "../booking.service";

@Controller("booking")
export class BookingQueryController {
  constructor(private readonly bookingService: BookingService) {}

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Get("/my-bookings")
  @HttpCode(200)
  getMyBookings(
    @CurrentUser() currentUser: JwtPayload
  ): ReturnType<BookingService["getMyBookings"]> {
    return this.bookingService.getMyBookings(currentUser.userId);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get("zone-info/:eventId/:zoneId")
  @HttpCode(200)
  getZoneBookingInfo(
    @Param("eventId") eventId: string,
    @Param("zoneId") zoneId: string
  ): ReturnType<BookingService["getZoneBookingInfo"]> {
    return this.bookingService.getZoneBookingInfo(eventId, zoneId);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Get("/:bookingCode")
  @HttpCode(200)
  getBookingByCode(
    @CurrentUser() currentUser: JwtPayload,
    @Param("bookingCode") bookingCode: string
  ): ReturnType<BookingService["getBookingByCode"]> {
    return this.bookingService.getBookingByCode(
      currentUser.userId,
      bookingCode
    );
  }
}
