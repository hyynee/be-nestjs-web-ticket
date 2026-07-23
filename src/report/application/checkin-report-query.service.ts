import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CheckInReportQueryDto } from "@src/report/dto/report-query.dto";
import {
  ReportEventScope,
  ReportScopePolicy,
} from "@src/report/domain/policies/report-scope.policy";
import {
  resolveReportDateRange,
  ResolvedReportRange,
} from "@src/report/domain/report-range.util";
import { CheckInReportResult } from "@src/report/domain/types/report.types";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";

@Injectable()
export class CheckInReportQueryService {
  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly scopePolicy: ReportScopePolicy,
    private readonly reportCache: ReportCacheService
  ) {}

  async execute(
    query: CheckInReportQueryDto,
    currentUser: JwtPayload
  ): Promise<CheckInReportResult> {
    const scope = await this.scopePolicy.resolveEventScope(
      currentUser,
      query.eventId,
      query.zoneId
    );
    const range = resolveReportDateRange(query.from, query.to);

    return this.reportCache.checkInReport(
      scope,
      range,
      query.zoneId,
      query.page,
      query.limit,
      () => this.computeResult(scope, range, query)
    );
  }

  private async computeResult(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    query: CheckInReportQueryDto
  ): Promise<CheckInReportResult> {
    const [summary, checkInByHour, checkInByZone, checkInByStaff] =
      await Promise.all([
        this.reportRepository.queryCheckInSummary(scope, range, query.zoneId),
        this.reportRepository.queryCheckInByHour(scope, range, query.zoneId),
        this.reportRepository.queryCheckInByZone(
          scope,
          range,
          query.zoneId,
          query.page,
          query.limit
        ),
        this.reportRepository.queryCheckInByStaff(
          scope,
          range,
          query.zoneId,
          query.page,
          query.limit
        ),
      ]);

    return {
      range: { from: range.fromIso, to: range.toIso },
      summary,
      checkInByHour,
      checkInByZone,
      checkInByStaff,
    };
  }
}
