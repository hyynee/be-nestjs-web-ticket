import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  DashboardOverviewDto,
  RevenueStatisticsByEventResponseDto,
} from "./dto/dashboard.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { getErrorMessage } from "@src/helper/getErrorMessage";
import {
  CheckInZoneStatistics,
  HotEventByRevenue,
  RevenueGroupBy,
  RevenueStatisticsResult,
  TopPotentialCustomer,
  TopSellingMetric,
} from "./domain/types/statistical.types";
import { StatisticalCacheService } from "./infrastructure/cache/statistical-cache.service";
import { StatisticalRepository } from "./infrastructure/persistence/statistical.repository";
import { Types } from "mongoose";

@Injectable()
export class StatisticalService {
  private readonly logger = new Logger(StatisticalService.name);

  constructor(
    private readonly statisticalRepository: StatisticalRepository,
    private readonly statisticalCache: StatisticalCacheService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  async warmGlobalCache(): Promise<void> {
    const results = await Promise.allSettled([
      this.statisticalCache.storeHotEvents(() =>
        this.statisticalRepository.queryHotEventsByRevenue()
      ),
      this.statisticalCache.storeTopSelling("tickets", () =>
        this.statisticalRepository.queryTopSellingEvents("tickets")
      ),
      this.statisticalCache.storeTopSelling("revenue", () =>
        this.statisticalRepository.queryTopSellingEvents("revenue")
      ),
      this.statisticalCache.storeTopCustomers(() =>
        this.statisticalRepository.queryTopPotentialCustomers()
      ),
      this.statisticalCache.storeOverviewGlobal(() =>
        this.statisticalRepository.queryOverviewStatistics()
      ),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        this.logger.error(
          `warmGlobalCache: a task failed — ${getErrorMessage(result.reason)}`
        );
      }
    }
  }

  async getHotEventsByRevenue(): Promise<HotEventByRevenue[]> {
    return this.statisticalCache.hotEvents(() =>
      this.statisticalRepository.queryHotEventsByRevenue()
    );
  }

  async getOverviewStatistics(
    eventId?: string,
    startDate?: string,
    endDate?: string
  ): Promise<DashboardOverviewDto> {
    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID format");
    }

    if (startDate && endDate) {
      return this.statisticalRepository.queryOverviewStatistics(
        eventId,
        startDate,
        endDate
      );
    }

    if (eventId) {
      return this.statisticalCache.overviewEvent(eventId, () =>
        this.statisticalRepository.queryOverviewStatistics(eventId)
      );
    }

    return this.statisticalCache.overviewGlobal(() =>
      this.statisticalRepository.queryOverviewStatistics()
    );
  }

  async getRevenueStatistics(
    eventId: string | undefined,
    from: string,
    to: string,
    groupBy: RevenueGroupBy = "day"
  ): Promise<RevenueStatisticsResult> {
    return this.statisticalCache.revenue(eventId, from, to, groupBy, () =>
      this.statisticalRepository.queryRevenueStatistics(
        eventId,
        from,
        to,
        groupBy
      )
    );
  }

  async getRevenueStatisticsByEvent(
    eventId: string | undefined,
    currentUser: JwtPayload
  ): Promise<RevenueStatisticsByEventResponseDto> {
    if (!eventId) throw new BadRequestException("Event ID is required");
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID format");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);
    return this.statisticalCache.revenueEvent(eventId, () =>
      this.statisticalRepository.queryRevenueStatisticsByEvent(eventId)
    );
  }

  async getTopSellingEvents(
    by: TopSellingMetric = "tickets"
  ): Promise<RevenueStatisticsByEventResponseDto[]> {
    return this.statisticalCache.topSelling(by, () =>
      this.statisticalRepository.queryTopSellingEvents(by)
    );
  }

  async getTopPotentialCustomers(): Promise<TopPotentialCustomer[]> {
    return this.statisticalCache.topCustomers(() =>
      this.statisticalRepository.queryTopPotentialCustomers()
    );
  }

  async getCheckInZones(
    eventId: string,
    currentUser: JwtPayload
  ): Promise<CheckInZoneStatistics[]> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID format");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);
    return this.statisticalCache.checkinZones(eventId, () =>
      this.statisticalRepository.queryCheckInZones(eventId)
    );
  }
}
