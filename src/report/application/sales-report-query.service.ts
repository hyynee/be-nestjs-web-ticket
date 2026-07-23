import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { SalesReportQueryDto } from "@src/report/dto/report-query.dto";
import {
  ReportEventScope,
  ReportScopePolicy,
} from "@src/report/domain/policies/report-scope.policy";
import {
  resolveReportDateRange,
  ResolvedReportRange,
} from "@src/report/domain/report-range.util";
import { SalesReportResult } from "@src/report/domain/types/report.types";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";

@Injectable()
export class SalesReportQueryService {
  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly scopePolicy: ReportScopePolicy,
    private readonly reportCache: ReportCacheService
  ) {}

  async execute(
    query: SalesReportQueryDto,
    currentUser: JwtPayload
  ): Promise<SalesReportResult> {
    // Authorization always re-runs on every call, cache hit or miss — only
    // the resulting data query is memoized below.
    const scope = await this.scopePolicy.resolveEventScope(
      currentUser,
      query.eventId,
      query.zoneId
    );
    const range = resolveReportDateRange(query.from, query.to);

    return this.reportCache.salesReport(
      scope,
      range,
      query.groupBy,
      query.page,
      query.limit,
      () => this.computeResult(scope, range, query)
    );
  }

  private async computeResult(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    query: SalesReportQueryDto
  ): Promise<SalesReportResult> {
    const [summary, timeSeries, revenueByEvent, revenueByZone] =
      await Promise.all([
        this.reportRepository.querySalesSummary(scope, range, query.zoneId),
        this.reportRepository.querySalesTimeSeries(
          scope,
          range,
          query.groupBy,
          query.zoneId
        ),
        this.reportRepository.querySalesByEvent(
          scope,
          range,
          query.page,
          query.limit
        ),
        this.reportRepository.querySalesByZone(
          scope,
          range,
          query.zoneId,
          query.page,
          query.limit
        ),
      ]);

    return {
      range: { from: range.fromIso, to: range.toIso },
      groupBy: query.groupBy,
      summary,
      timeSeries,
      revenueByEvent,
      revenueByZone,
    };
  }
}
