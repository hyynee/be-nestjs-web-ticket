import { Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { AuthGuard } from "@nestjs/passport";
import { ApiCookieAuth, ApiOperation } from "@nestjs/swagger";
import { RolesGuard } from "@src/guards/role.guard";
import { Roles } from "@src/common/decorators/roles.decorator";
import { CurrentUser } from "@src/auth/decorator/currentUser.decorator";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ReportService } from "./report.service";
import {
  CheckInReportQueryDto,
  OrganizerReportQueryDto,
  PaymentReconciliationQueryDto,
  RefundReportQueryDto,
  SalesReportQueryDto,
} from "./dto/report-query.dto";
import {
  CheckInReportResult,
  OrganizerReportResult,
  PaymentReconciliationResult,
  RefundReportResult,
  SalesReportResult,
} from "./domain/types/report.types";

@ApiCookieAuth("access_token")
@UseGuards(AuthGuard("jwt"), RolesGuard)
@Roles("admin", "organizer")
@Controller("reports")
export class ReportController {
  constructor(private readonly reportService: ReportService) {}

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("sales")
  @ApiOperation({ summary: "Sales report (revenue, refunds, breakdowns)" })
  async getSalesReport(
    @Query() query: SalesReportQueryDto,
    @CurrentUser() currentUser: JwtPayload
  ): Promise<SalesReportResult> {
    return this.reportService.getSalesReport(query, currentUser);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("checkin")
  @ApiOperation({ summary: "Check-in report (rate, by hour/zone/staff)" })
  async getCheckInReport(
    @Query() query: CheckInReportQueryDto,
    @CurrentUser() currentUser: JwtPayload
  ): Promise<CheckInReportResult> {
    return this.reportService.getCheckInReport(query, currentUser);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("refunds")
  @ApiOperation({ summary: "Refund report (status counts, by event/provider)" })
  async getRefundReport(
    @Query() query: RefundReportQueryDto,
    @CurrentUser() currentUser: JwtPayload
  ): Promise<RefundReportResult> {
    return this.reportService.getRefundReport(query, currentUser);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("payment-reconciliation")
  @ApiOperation({ summary: "Payment/booking/ticket reconciliation anomalies" })
  async getPaymentReconciliationReport(
    @Query() query: PaymentReconciliationQueryDto,
    @CurrentUser() currentUser: JwtPayload
  ): Promise<PaymentReconciliationResult> {
    return this.reportService.getPaymentReconciliationReport(
      query,
      currentUser
    );
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("organizer/:organizerId")
  @ApiOperation({ summary: "Aggregate report for one organizer's events" })
  async getOrganizerReport(
    @Param("organizerId") organizerId: string,
    @Query() query: OrganizerReportQueryDto,
    @CurrentUser() currentUser: JwtPayload
  ): Promise<OrganizerReportResult> {
    return this.reportService.getOrganizerReport(
      organizerId,
      query,
      currentUser
    );
  }
}
