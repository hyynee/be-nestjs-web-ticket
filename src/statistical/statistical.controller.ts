import { Controller, UseGuards, Get, Query, Param } from '@nestjs/common';
import { StatisticalService } from './statistical.service';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from "@src/guards/role.guard";
import { DashboardOverviewDto, RevenueStatisticsResponseDto } from './dto/dashboard.dto';
import { DashboardQueryDto, RevenueStatisticsQueryDto } from './dto/dashboard-query.dto';


@ApiBearerAuth()
@Controller('statistical')
export class StatisticalController {
  constructor(private readonly statisticalService: StatisticalService) { }

   @Get('top-selling-events')
  @ApiOperation({ summary: 'Get top selling events' })
  async getTopSellingEvents(
    @Query('by') by: 'tickets' | 'revenue' = 'tickets',
  ) {
    return this.statisticalService.getTopSellingEvents(by);
  }

  @Get('overview')
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  @ApiOperation({ summary: 'Get dashboard overview statistics' })
  @ApiResponse({ status: 200, type: DashboardOverviewDto })
  async getOverviewStatistics(
    @Query() query: DashboardQueryDto,
  ): Promise<DashboardOverviewDto> {
    return this.statisticalService.getOverviewStatistics(
      query.eventId,
      query.startDate,
      query.endDate,
    );
  };

  @Get('revenue')
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  async getRevenueStatistics(
    @Query() query: RevenueStatisticsQueryDto,
  ): Promise<RevenueStatisticsResponseDto> {
    return this.statisticalService.getRevenueStatistics(
      query.eventId,
      query.from,
      query.to,
      query.groupBy,
    );
  }

  @Get('revenue/:eventId')
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  @ApiOperation({ summary: 'Get revenue statistics by event' })
  async getRevenueStatisticsByEvent(
    @Param('eventId') eventId: string,
  ) {
    return this.statisticalService.getRevenueStatisticsByEvent(eventId);
  }
  @Get('potential-customers')
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  @ApiOperation({ summary: 'Get top potential customers' })
  async getTopPotentialCustomers() {
    return this.statisticalService.getTopPotentialCustomers();
  }

  @Get('checkin-zones/:eventId')
  @UseGuards(AuthGuard('jwt'), new RolesGuard(['admin']))
  @ApiOperation({ summary: 'Get check-in user with zones' })
  async getCheckInZones (
    @Param('eventId') eventId: string,
  ) {
    return this.statisticalService.getCheckInZones(eventId);
  }
}
