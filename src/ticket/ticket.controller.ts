import { Controller, Get, HttpCode, Param, UseGuards } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { ApiBearerAuth } from '@nestjs/swagger';
import { Post, Body } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '@src/guards/role.guard';
import { JwtPayload } from '@src/auth/dto/jwt-payload.dto';
import { CurrentUser } from '@src/auth/decorator/currentUser.decorator';

@Controller('ticket')
export class TicketController {
  constructor(private readonly ticketService: TicketService) { }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(201)
  @Post('from-booking')
  async createTicketsFromBooking(
    @Body('bookingCode') bookingCode: string,
  ) {
    return this.ticketService.createTicketsFromBooking(bookingCode);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @Get('validate/:ticketCode')
  async validateTicket(
    @Param('ticketCode') ticketCode: string,
  ) {
    return this.ticketService.validateTicket(ticketCode);
  }
  @ApiBearerAuth()
  @UseGuards(AuthGuard('jwt'))
  @HttpCode(200)
  @Get(':ticketCode')
  async getTicketByCode(
    @Param('ticketCode') ticketCode: string,
  ) {
    return this.ticketService.getTicketByCode(ticketCode);
  }


  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @HttpCode(200)
  @Post('checkin')
  async checkInTicket(
    @Body('ticketCode') ticketCode: string,
    @Body('location') location: string,
    @Body('deviceInfo') deviceInfo: string,
    @Body('ipAddress') ipAddress: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const adMinId = user.userId;
    return this.ticketService.checkInTicket(ticketCode, location, deviceInfo, ipAddress, adMinId);
  }

  @ApiBearerAuth()
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Post('cancel')
  async cancelTicket(
    @Body('ticketCode') ticketCode: string,
    @CurrentUser() user: JwtPayload,
  ) {
    const userId = user.userId;
    return this.ticketService.cancelTicket(ticketCode, userId);
  }
}