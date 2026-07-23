import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { OrganizerReportQueryDto } from "@src/report/dto/report-query.dto";
import {
  ReportEventScope,
  ReportScopePolicy,
} from "@src/report/domain/policies/report-scope.policy";
import { resolveReportDateRange } from "@src/report/domain/report-range.util";
import { OrganizerReportResult } from "@src/report/domain/types/report.types";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";

@Injectable()
export class OrganizerReportQueryService {
  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly scopePolicy: ReportScopePolicy,
    private readonly reportCache: ReportCacheService
  ) {}

  async execute(
    organizerId: string,
    query: OrganizerReportQueryDto,
    currentUser: JwtPayload
  ): Promise<OrganizerReportResult> {
    // Authorization (admin, or organizer viewing their own id) always runs
    // before the cache lookup below.
    const managedEventIds = await this.scopePolicy.resolveOrganizerScope(
      currentUser,
      organizerId
    );
    const range = resolveReportDateRange(query.from, query.to);

    return this.reportCache.organizerReport(
      organizerId,
      range,
      query.page,
      query.limit,
      () => this.computeResult(organizerId, managedEventIds, range, query)
    );
  }

  private async computeResult(
    organizerId: string,
    managedEventIds: Types.ObjectId[],
    range: ReturnType<typeof resolveReportDateRange>,
    query: OrganizerReportQueryDto
  ): Promise<OrganizerReportResult> {
    const scope: ReportEventScope = { eventIdIn: managedEventIds };

    const [sales, checkIn, refunds, events] = await Promise.all([
      this.reportRepository.querySalesSummary(scope, range),
      this.reportRepository.queryCheckInSummary(scope, range),
      this.reportRepository.queryRefundSummary(scope, range),
      this.reportRepository.queryOrganizerEventBreakdown(
        managedEventIds,
        range,
        query.page,
        query.limit
      ),
    ]);

    return {
      organizerId,
      range: { from: range.fromIso, to: range.toIso },
      totalEventsManaged: managedEventIds.length,
      sales,
      checkIn,
      refunds,
      events,
    };
  }
}
