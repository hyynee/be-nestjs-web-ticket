import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiCookieAuth, ApiOperation } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AdminOpsService } from "./admin-ops.service";
import { AdminAnomalyQueryDto } from "./dto/admin-anomaly-query.dto";
import {
  AdminAnomalyResult,
  AdminSystemSummaryResult,
  RegenerateQrResult,
  ReissueTicketsResult,
  ResendConfirmationResult,
} from "./domain/types/admin-ops.types";

@ApiCookieAuth("access_token")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin")
@Controller("admin")
export class AdminOpsController {
  constructor(private readonly adminOpsService: AdminOpsService) {}

  @Get("system/summary")
  @ApiOperation({ summary: "Operational health summary" })
  async getSystemSummary(): Promise<AdminSystemSummaryResult> {
    return this.adminOpsService.getSystemSummaryResult();
  }

  @Get("system/anomalies")
  @ApiOperation({ summary: "Detected data-integrity anomalies" })
  async getAnomalies(
    @Query() query: AdminAnomalyQueryDto
  ): Promise<AdminAnomalyResult> {
    return this.adminOpsService.getAnomaliesResult(query);
  }

  @Post("bookings/:bookingCode/reissue-tickets")
  @HttpCode(200)
  @ApiOperation({ summary: "Re-issue tickets for a paid booking" })
  async reissueTickets(
    @Param("bookingCode") bookingCode: string,
    @CurrentUser() admin: JwtPayload
  ): Promise<ReissueTicketsResult> {
    return this.adminOpsService.reissueTicketsForBooking(bookingCode, admin);
  }

  @Post("bookings/:bookingCode/resend-confirmation")
  @HttpCode(200)
  @ApiOperation({ summary: "Resend the booking confirmation email" })
  async resendConfirmation(
    @Param("bookingCode") bookingCode: string,
    @CurrentUser() admin: JwtPayload
  ): Promise<ResendConfirmationResult> {
    return this.adminOpsService.resendBookingConfirmation(bookingCode, admin);
  }

  @Post("tickets/:ticketCode/regenerate-qr")
  @HttpCode(200)
  @ApiOperation({ summary: "Regenerate a ticket's QR code image" })
  async regenerateQr(
    @Param("ticketCode") ticketCode: string,
    @CurrentUser() admin: JwtPayload
  ): Promise<RegenerateQrResult> {
    return this.adminOpsService.regenerateTicketQrCode(ticketCode, admin);
  }
}
