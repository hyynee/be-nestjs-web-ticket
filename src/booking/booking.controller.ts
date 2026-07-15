import {
  Controller,
  Post,
  UseGuards,
  Body,
  HttpCode,
  Get,
  Param,
  Patch,
  Query,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { BookingService } from "./booking.service";
import { ApiCookieAuth } from "@nestjs/swagger";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { AuthGuard } from "@nestjs/passport";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { CreateBookingDto } from "./dto/create-booking.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { QueryBookingDto } from "./dto/query-booking.dto";
import { CancelBookingDto } from "./dto/cancel-booking.dto";
import { AdminCancelBookingDto } from "./dto/admin-cancel-booking.dto";

@Controller("booking")
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @Throttle({ short: { limit: 3, ttl: 10000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), VerifiedUserGuard)
  @Post("")
  @HttpCode(201)
  createBooking(
    @CurrentUser() currentUser: JwtPayload,
    @Body() data: CreateBookingDto
  ) {
    const userId = currentUser.userId;
    return this.bookingService.createBooking(userId, data);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Get("/my-bookings")
  @HttpCode(200)
  getMyBookings(@CurrentUser() currentUser: JwtPayload) {
    const userId = currentUser.userId;
    return this.bookingService.getMyBookings(userId);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Get("/:bookingCode")
  @HttpCode(200)
  getBookingByCode(
    @CurrentUser() currentUser: JwtPayload,
    @Param("bookingCode") bookingCode: string
  ) {
    const userId = currentUser.userId;
    return this.bookingService.getBookingByCode(userId, bookingCode);
  }

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get("zone-info/:eventId/:zoneId")
  @HttpCode(200)
  getZoneBookingInfo(
    @Param("eventId") eventId: string,
    @Param("zoneId") zoneId: string
  ) {
    return this.bookingService.getZoneBookingInfo(eventId, zoneId);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Patch("/cancel-booking")
  @HttpCode(200)
  cancelBooking(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: CancelBookingDto
  ) {
    const userId = currentUser.userId;
    return this.bookingService.cancelBooking(userId, dto);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @Roles("admin", "organizer")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @Get("/admin/all-bookings")
  @HttpCode(200)
  getAllBookings(
    @Query() query: QueryBookingDto,
    @CurrentUser() currentUser: JwtPayload
  ) {
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
  ) {
    return this.bookingService.adminCancelBooking(
      bookingId,
      currentUser.userId,
      dto.reason
    );
  }
}
