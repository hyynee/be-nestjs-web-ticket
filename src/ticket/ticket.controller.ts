import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Req,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { TicketService } from "./ticket.service";
import { ApiCookieAuth } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { QueryTicketDto } from "./dto/query.dto";
import { MyTicketsQueryDto } from "./dto/my-tickets-query.dto";
import type { Request } from "express";

const resolveClientIp = (request: Request): string => {
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedIp = Array.isArray(forwardedFor)
    ? forwardedFor[0]
    : typeof forwardedFor === "string"
      ? forwardedFor.split(",")[0]
      : undefined;

  return (
    forwardedIp?.trim() || request.ip || request.socket?.remoteAddress || ""
  );
};

@Controller("ticket")
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(201)
  @Post("from-booking")
  async createTicketsFromBooking(
    @CurrentUser() user: JwtPayload,
    @Body("bookingCode") bookingCode: string
  ) {
    return this.ticketService.createTicketsFromBooking(
      bookingCode,
      undefined,
      user.userId
    );
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Get("my-tickets")
  async getMyTickets(
    @CurrentUser() user: JwtPayload,
    @Query() query: MyTicketsQueryDto
  ) {
    return this.ticketService.getMyTickets(user.userId, query);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Get("validate/:ticketCode")
  async validateTicket(
    @CurrentUser() user: JwtPayload,
    @Param("ticketCode") ticketCode: string
  ) {
    return this.ticketService.validateTicket(
      ticketCode,
      user.userId,
      user.role
    );
  }
  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Get(":ticketCode")
  async getTicketByCode(
    @CurrentUser() user: JwtPayload,
    @Param("ticketCode") ticketCode: string
  ) {
    const userId = user.userId;
    return this.ticketService.getTicketByCode(userId, ticketCode);
  }

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Post("checkin")
  async checkInTicket(
    @Body("ticketCode") ticketCode: string,
    @Req() req: Request,
    @CurrentUser() user: JwtPayload,
    @Body("location") location?: string,
    @Body("deviceInfo") deviceInfo?: string
  ) {
    const adMinId = user.userId;
    const ipAddress = resolveClientIp(req);

    return this.ticketService.checkInTicket(
      ticketCode,
      location ?? "",
      deviceInfo ?? "",
      ipAddress,
      adMinId
    );
  }

  @ApiCookieAuth("access_token")
  @UseGuards(AuthGuard("jwt"))
  @HttpCode(200)
  @Post("cancel")
  async cancelTicket(
    @Body("ticketCode") ticketCode: string,
    @CurrentUser() user: JwtPayload
  ) {
    const userId = user.userId;
    return this.ticketService.cancelTicket(ticketCode, userId);
  }

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Get("checkin-history/:ticketCode")
  async getCheckInHistory(@Param("ticketCode") ticketCode: string) {
    return this.ticketService.getCheckInHistory(ticketCode);
  }

  @ApiCookieAuth("access_token")
  @Roles("admin")
  @UseGuards(AuthGuard("jwt"), RolesGuard)
  @HttpCode(200)
  @Get("admin/all-tickets")
  async getAllTickets(@Query() query: QueryTicketDto) {
    return this.ticketService.getAllTickets(query);
  }
}
