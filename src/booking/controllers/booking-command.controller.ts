import {
  Body,
  Controller,
  HttpCode,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { VerifiedUserGuard } from "@src/guards/verified-user.guard";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { BookingService } from "../booking.service";
import { CreateBookingDto } from "../dto/create-booking.dto";
import { CancelBookingDto } from "../dto/cancel-booking.dto";

@Controller("booking")
export class BookingCommandController {
  constructor(private readonly bookingService: BookingService) {}

  @Throttle({ short: { limit: 3, ttl: 10000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"), VerifiedUserGuard)
  @Post("")
  @HttpCode(201)
  createBooking(
    @CurrentUser() currentUser: JwtPayload,
    @Body() data: CreateBookingDto
  ): ReturnType<BookingService["createBooking"]> {
    return this.bookingService.createBooking(currentUser.userId, data);
  }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @Patch("/cancel-booking")
  @HttpCode(200)
  cancelBooking(
    @CurrentUser() currentUser: JwtPayload,
    @Body() dto: CancelBookingDto
  ): ReturnType<BookingService["cancelBooking"]> {
    return this.bookingService.cancelBooking(currentUser.userId, dto);
  }
}
