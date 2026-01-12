import { Controller, UseGuards, Get, Query } from '@nestjs/common';
import { StatisticalService } from './statistical.service';
import { ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from "@src/guards/role.guard";
import { CurrentUser } from '@src/auth/decorator/currentUser.decorator';
import { JwtPayload } from '@src/auth/dto/jwt-payload.dto';
import { DashboardOverviewDto, RevenueStatisticsResponseDto } from './dto/dashboard.dto';
import { DashboardQueryDto, RevenueStatisticsByEventQueryDto, RevenueStatisticsQueryDto } from './dto/dashboard-query.dto';


@ApiBearerAuth()
@Controller('statistical')
export class StatisticalController {
  constructor(private readonly statisticalService: StatisticalService) { }

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
  async getRevenueStatisticsByEvent(
    @Query() data: RevenueStatisticsByEventQueryDto,
  ) {
    return this.statisticalService.getRevenueStatisticsByEvent(
      data.eventId,
    );
  }
}
