import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BookingService } from "../booking.service";
import { QueryBookingDto } from "../dto/query-booking.dto";
import { AdminCancelBookingDto } from "../dto/admin-cancel-booking.dto";

@Controller("booking")
export class BookingAdminController {
  constructor(private readonly bookingService: BookingService) {}

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("/admin/all-bookings")
  @HttpCode(200)
  getAllBookings(
    @Query() query: QueryBookingDto,
    @CurrentUser() currentUser: JwtPayload
  ): ReturnType<BookingService["getAllBookings"]> {
    return this.bookingService.getAllBookings(query, currentUser);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Patch("/admin/cancel/:bookingId")
  @HttpCode(200)
  adminCancelBooking(
    @CurrentUser() currentUser: JwtPayload,
    @Param("bookingId") bookingId: string,
    @Body() dto: AdminCancelBookingDto
  ): ReturnType<BookingService["adminCancelBooking"]> {
    return this.bookingService.adminCancelBooking(
      bookingId,
      currentUser.userId,
      dto.reason
    );
  }
}
