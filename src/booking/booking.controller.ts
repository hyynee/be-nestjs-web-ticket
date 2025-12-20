import { Controller, Post, UseGuards,Body, HttpCode, Get, Param, Patch,Query } from '@nestjs/common';
import { BookingService } from './booking.service';
import { ApiBearerAuth } from '@nestjs/swagger';
import { RolesGuard } from '@src/guards/role.guard';
import { AuthGuard } from "@nestjs/passport";
import { CurrentUser } from '@src/auth/decorator/currentUser.decorator';
import { CreateBookingDto } from './dto/create-booking.dto';
import { JwtPayload } from '@src/auth/dto/jwt-payload.dto';
import { QueryBookingDto } from './dto/query-booking.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';


@Controller('booking')
export class BookingController {
  constructor(private readonly bookingService: BookingService) {}

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @Post("")
  @HttpCode(201)
  createBooking(@CurrentUser() currentUser: JwtPayload, @Body() data: CreateBookingDto) {
    const userId = currentUser.userId;
    return this.bookingService.createBooking(userId, data);
  }


  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @Get("/my-bookings")
  @HttpCode(200)
  getMyBookings(@CurrentUser() currentUser: JwtPayload) {
    const userId = currentUser.userId;
    return this.bookingService.getMyBookings(userId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @Get("/:bookingCode")
  @HttpCode(200)
  getBookingByCode(
    @CurrentUser () currentUser: JwtPayload,
    @Param ('bookingCode') bookingCode: string) {
      const userId = currentUser.userId;
    return this.bookingService.getBookingByCode(userId,bookingCode);
  }

  @Get("zone-info/:eventId/:zoneId")
  @HttpCode(200)
  getZoneBookingInfo(
    @Param ('eventId') eventId: string,
    @Param ('zoneId') zoneId: string) {
    return this.bookingService.getZoneBookingInfo(eventId,zoneId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @Patch("/cancel-booking")
  @HttpCode(200)
  cancelBooking(
    @CurrentUser () currentUser: JwtPayload,
    @Body ('bookingCode') bookingCode: string
  ) {
    const userId = currentUser.userId;
    return this.bookingService.cancelBooking(userId,bookingCode);
  }


  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @Get("/admin/all-bookings")
  @HttpCode(200)
  getAllBookings(@Query() query: QueryBookingDto) {
    return this.bookingService.getAllBookings(query);
  }

}
