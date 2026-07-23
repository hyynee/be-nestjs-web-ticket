import { Types } from "mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { RefundProvider } from "@src/schemas/refund-request.schema";
import { ReportScopePolicy } from "../domain/policies/report-scope.policy";
import { ReportCacheService } from "../infrastructure/cache/report-cache.service";
import { ReportRepository } from "../infrastructure/persistence/report.repository";
import { CheckInReportQueryService } from "./checkin-report-query.service";
import { OrganizerReportQueryService } from "./organizer-report-query.service";
import { PaymentReconciliationQueryService } from "./payment-reconciliation-query.service";
import { RefundReportQueryService } from "./refund-report-query.service";
import { SalesReportQueryService } from "./sales-report-query.service";

const adminUser: JwtPayload = {
  userId: new Types.ObjectId().toHexString(),
  role: "admin",
  iat: 0,
  exp: 0,
};

function makeRepositoryMock() {
  return {
    querySalesSummary: jest.fn().mockResolvedValue({
      grossRevenue: 0,
      netRevenue: 0,
      refundAmount: 0,
      ticketsSold: 0,
      bookingCount: 0,
      averageOrderValue: 0,
      currency: "vnd",
    }),
    querySalesTimeSeries: jest.fn().mockResolvedValue([]),
    querySalesByEvent: jest
      .fn()
      .mockResolvedValue({ items: [], meta: paginationMeta() }),
    querySalesByZone: jest
      .fn()
      .mockResolvedValue({ items: [], meta: paginationMeta() }),
    queryCheckInSummary: jest.fn().mockResolvedValue({
      totalValidTickets: 0,
      checkedInTickets: 0,
      noShowCount: 0,
      checkInRate: 0,
    }),
    queryCheckInByHour: jest.fn().mockResolvedValue([]),
    queryCheckInByZone: jest
      .fn()
      .mockResolvedValue({ items: [], meta: paginationMeta() }),
    queryCheckInByStaff: jest
      .fn()
      .mockResolvedValue({ items: [], meta: paginationMeta() }),
    queryRefundSummary: jest.fn().mockResolvedValue({
      requested: 0,
      approved: 0,
      rejected: 0,
      succeeded: 0,
      failed: 0,
      totalRefundAmount: 0,
    }),
    queryRefundByEvent: jest
      .fn()
      .mockResolvedValue({ items: [], meta: paginationMeta() }),
    queryRefundByProvider: jest.fn().mockResolvedValue([]),
    queryPaymentSucceededBookingNotConfirmed: jest.fn().mockResolvedValue([]),
    queryBookingPaidWithoutTicket: jest.fn().mockResolvedValue([]),
    queryBookingCancelledNotRefunded: jest.fn().mockResolvedValue([]),
    queryPaymentWebhookFailed: jest.fn().mockResolvedValue([]),
    queryDuplicatePaymentRecords: jest.fn().mockResolvedValue([]),
    queryOrganizerEventBreakdown: jest
      .fn()
      .mockResolvedValue({ items: [], meta: paginationMeta() }),
  };
}

function paginationMeta() {
  return {
    currentPage: 1,
    itemsPerPage: 20,
    totalItems: 0,
    totalPages: 0,
    hasPreviousPage: false,
    hasNextPage: false,
  };
}

function makeScopePolicyMock() {
  return {
    resolveEventScope: jest.fn().mockResolvedValue({}),
    resolveOrganizerScope: jest.fn().mockResolvedValue([]),
  };
}

/**
 * Cache pass-through mock: always calls `compute()` immediately, so these
 * wiring tests exercise the real repository-call parameters regardless of
 * caching behavior (covered separately in report-cache.service.spec.ts).
 */
function makeReportCacheMock() {
  return {
    salesReport: jest.fn((_s, _r, _g, _p, _l, compute: () => unknown) =>
      compute()
    ),
    checkInReport: jest.fn((_s, _r, _z, _p, _l, compute: () => unknown) =>
      compute()
    ),
    refundReport: jest.fn((_s, _r, _pr, _p, _l, compute: () => unknown) =>
      compute()
    ),
    reconciliationReport: jest.fn((_s, _r, _p, _l, compute: () => unknown) =>
      compute()
    ),
    organizerReport: jest.fn((_o, _r, _p, _l, compute: () => unknown) =>
      compute()
    ),
  };
}

describe("Report application query services — wiring", () => {
  let repository: ReturnType<typeof makeRepositoryMock>;
  let scopePolicy: ReturnType<typeof makeScopePolicyMock>;
  let reportCache: ReturnType<typeof makeReportCacheMock>;

  beforeEach(() => {
    repository = makeRepositoryMock();
    scopePolicy = makeScopePolicyMock();
    reportCache = makeReportCacheMock();
  });

  it("SalesReportQueryService resolves scope/range once and echoes the range/groupBy", async () => {
    const service = new SalesReportQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );

    const result = await service.execute(
      {
        from: "2026-03-01",
        to: "2026-03-31",
        groupBy: "day",
        page: 1,
        limit: 20,
      },
      adminUser
    );

    expect(scopePolicy.resolveEventScope).toHaveBeenCalledWith(
      adminUser,
      undefined,
      undefined
    );
    expect(result.groupBy).toBe("day");
    expect(result.range.from).toContain("2026-03-01");
    expect(repository.querySalesByZone).toHaveBeenCalledWith(
      {},
      expect.anything(),
      undefined,
      1,
      20
    );
  });

  it("CheckInReportQueryService passes zoneId through to every repository call", async () => {
    const service = new CheckInReportQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );
    const zoneId = new Types.ObjectId().toHexString();

    await service.execute({ zoneId, page: 2, limit: 5 }, adminUser);

    expect(repository.queryCheckInByZone).toHaveBeenCalledWith(
      {},
      expect.anything(),
      zoneId,
      2,
      5
    );
    expect(repository.queryCheckInByStaff).toHaveBeenCalledWith(
      {},
      expect.anything(),
      zoneId,
      2,
      5
    );
  });

  it("RefundReportQueryService passes provider through to every repository call", async () => {
    const service = new RefundReportQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );

    await service.execute(
      { provider: RefundProvider.PAYPAL, page: 1, limit: 20 },
      adminUser
    );

    expect(repository.queryRefundSummary).toHaveBeenCalledWith(
      {},
      expect.anything(),
      RefundProvider.PAYPAL
    );
    expect(repository.queryRefundByEvent).toHaveBeenCalledWith(
      {},
      expect.anything(),
      RefundProvider.PAYPAL,
      1,
      20
    );
  });

  it("PaymentReconciliationQueryService skips webhook-failed lookup for a restricted (non-admin-unrestricted) scope", async () => {
    scopePolicy.resolveEventScope.mockResolvedValue({
      eventIdEq: new Types.ObjectId(),
    });
    const service = new PaymentReconciliationQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );

    await service.execute({ page: 1, limit: 20 }, adminUser);

    expect(repository.queryPaymentWebhookFailed).not.toHaveBeenCalled();
  });

  it("PaymentReconciliationQueryService includes webhook-failed lookup for an unrestricted scope", async () => {
    scopePolicy.resolveEventScope.mockResolvedValue({});
    const service = new PaymentReconciliationQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );

    await service.execute({ page: 1, limit: 20 }, adminUser);

    expect(repository.queryPaymentWebhookFailed).toHaveBeenCalled();
  });

  it("OrganizerReportQueryService scopes every repository call to the organizer's managed events", async () => {
    const organizerId = new Types.ObjectId().toHexString();
    const managedIds = [new Types.ObjectId()];
    scopePolicy.resolveOrganizerScope.mockResolvedValue(managedIds);

    const service = new OrganizerReportQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );

    const result = await service.execute(
      organizerId,
      { page: 1, limit: 20 },
      adminUser
    );

    expect(scopePolicy.resolveOrganizerScope).toHaveBeenCalledWith(
      adminUser,
      organizerId
    );
    expect(result.totalEventsManaged).toBe(1);
    expect(repository.querySalesSummary).toHaveBeenCalledWith(
      { eventIdIn: managedIds },
      expect.anything()
    );
    expect(repository.queryOrganizerEventBreakdown).toHaveBeenCalledWith(
      managedIds,
      expect.anything(),
      1,
      20
    );
  });

  it("authorization always runs even though the cache mock short-circuits computation", async () => {
    reportCache.salesReport.mockImplementation(() =>
      Promise.resolve("cached-result" as never)
    );
    const service = new SalesReportQueryService(
      repository as unknown as ReportRepository,
      scopePolicy as unknown as ReportScopePolicy,
      reportCache as unknown as ReportCacheService
    );

    const result = await service.execute(
      { groupBy: "day", page: 1, limit: 20 },
      adminUser
    );

    expect(scopePolicy.resolveEventScope).toHaveBeenCalled();
    expect(result).toBe("cached-result");
    expect(repository.querySalesSummary).not.toHaveBeenCalled();
  });
});
