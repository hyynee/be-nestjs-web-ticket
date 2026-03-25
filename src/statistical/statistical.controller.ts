import { Controller, UseGuards, Get, Query, Param } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { StatisticalService } from "./statistical.service";
import { ApiCookieAuth, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AuthGuard } from "@nestjs/passport";
import { RolesGuard } from "@src/guards/role.guard";
import {
  DashboardOverviewDto,
  RevenueStatisticsResponseDto,
} from "./dto/dashboard.dto";
import {
  DashboardQueryDto,
  RevenueStatisticsQueryDto,
} from "./dto/dashboard-query.dto";

@ApiCookieAuth("access_token")
@Controller("statistical")
export class StatisticalController {
  constructor(private readonly statisticalService: StatisticalService) {}

  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get("hot-events")
  @ApiOperation({ summary: "Get hot events based on revenue" })
  async getHotEventsByRevenue() {
    return this.statisticalService.getHotEventsByRevenue();
  }
  @Throttle({ medium: { limit: 120, ttl: 60000 } })
  @Get("top-selling-events")
  @ApiOperation({ summary: "Get top selling events" })
  async getTopSellingEvents(
    @Query("by") by: "tickets" | "revenue" = "tickets"
  ) {
    return this.statisticalService.getTopSellingEvents(by);
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("overview")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @ApiOperation({ summary: "Get dashboard overview statistics" })
  @ApiResponse({ status: 200, type: DashboardOverviewDto })
  async getOverviewStatistics(
    @Query() query: DashboardQueryDto
  ): Promise<DashboardOverviewDto> {
    return this.statisticalService.getOverviewStatistics(
      query.eventId,
      query.startDate,
      query.endDate
    );
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("revenue")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  async getRevenueStatistics(
    @Query() query: RevenueStatisticsQueryDto
  ): Promise<RevenueStatisticsResponseDto> {
    return this.statisticalService.getRevenueStatistics(
      query.eventId,
      query.from,
      query.to,
      query.groupBy
    );
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("revenue/:eventId")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @ApiOperation({ summary: "Get revenue statistics by event" })
  async getRevenueStatisticsByEvent(@Param("eventId") eventId: string) {
    return this.statisticalService.getRevenueStatisticsByEvent(eventId);
  }
  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("potential-customers")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @ApiOperation({ summary: "Get top potential customers" })
  async getTopPotentialCustomers() {
    return this.statisticalService.getTopPotentialCustomers();
  }

  @Throttle({ medium: { limit: 60, ttl: 60000 } })
  @Get("checkin-zones/:eventId")
  @UseGuards(AuthGuard("jwt"), new RolesGuard(["admin"]))
  @ApiOperation({ summary: "Get check-in user with zones" })
  async getCheckInZones(@Param("eventId") eventId: string) {
    return this.statisticalService.getCheckInZones(eventId);
  }
}
