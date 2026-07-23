import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { RefundReportQueryDto } from "@src/report/dto/report-query.dto";
import {
  ReportEventScope,
  ReportScopePolicy,
} from "@src/report/domain/policies/report-scope.policy";
import {
  resolveReportDateRange,
  ResolvedReportRange,
} from "@src/report/domain/report-range.util";
import { RefundReportResult } from "@src/report/domain/types/report.types";
import { ReportCacheService } from "@src/report/infrastructure/cache/report-cache.service";
import { ReportRepository } from "@src/report/infrastructure/persistence/report.repository";

@Injectable()
export class RefundReportQueryService {
  constructor(
    private readonly reportRepository: ReportRepository,
    private readonly scopePolicy: ReportScopePolicy,
    private readonly reportCache: ReportCacheService
  ) {}

  async execute(
    query: RefundReportQueryDto,
    currentUser: JwtPayload
  ): Promise<RefundReportResult> {
    const scope = await this.scopePolicy.resolveEventScope(
      currentUser,
      query.eventId
    );
    const range = resolveReportDateRange(query.from, query.to);

    return this.reportCache.refundReport(
      scope,
      range,
      query.provider,
      query.page,
      query.limit,
      () => this.computeResult(scope, range, query)
    );
  }

  private async computeResult(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    query: RefundReportQueryDto
  ): Promise<RefundReportResult> {
    const [summary, refundAmountByEvent, refundAmountByProvider] =
      await Promise.all([
        this.reportRepository.queryRefundSummary(scope, range, query.provider),
        this.reportRepository.queryRefundByEvent(
          scope,
          range,
          query.provider,
          query.page,
          query.limit
        ),
        this.reportRepository.queryRefundByProvider(
          scope,
          range,
          query.provider
        ),
      ]);

    return {
      range: { from: range.fromIso, to: range.toIso },
      summary,
      refundAmountByEvent,
      refundAmountByProvider,
    };
  }
}
