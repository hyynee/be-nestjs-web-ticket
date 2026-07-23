import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { CheckInReportQueryService } from "./application/checkin-report-query.service";
import { OrganizerReportQueryService } from "./application/organizer-report-query.service";
import { PaymentReconciliationQueryService } from "./application/payment-reconciliation-query.service";
import { RefundReportQueryService } from "./application/refund-report-query.service";
import { SalesReportQueryService } from "./application/sales-report-query.service";
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

@Injectable()
export class ReportService {
  constructor(
    private readonly salesReportQuery: SalesReportQueryService,
    private readonly checkInReportQuery: CheckInReportQueryService,
    private readonly refundReportQuery: RefundReportQueryService,
    private readonly reconciliationQuery: PaymentReconciliationQueryService,
    private readonly organizerReportQuery: OrganizerReportQueryService
  ) {}

  getSalesReport(
    query: SalesReportQueryDto,
    currentUser: JwtPayload
  ): Promise<SalesReportResult> {
    return this.salesReportQuery.execute(query, currentUser);
  }

  getCheckInReport(
    query: CheckInReportQueryDto,
    currentUser: JwtPayload
  ): Promise<CheckInReportResult> {
    return this.checkInReportQuery.execute(query, currentUser);
  }

  getRefundReport(
    query: RefundReportQueryDto,
    currentUser: JwtPayload
  ): Promise<RefundReportResult> {
    return this.refundReportQuery.execute(query, currentUser);
  }

  getPaymentReconciliationReport(
    query: PaymentReconciliationQueryDto,
    currentUser: JwtPayload
  ): Promise<PaymentReconciliationResult> {
    return this.reconciliationQuery.execute(query, currentUser);
  }

  getOrganizerReport(
    organizerId: string,
    query: OrganizerReportQueryDto,
    currentUser: JwtPayload
  ): Promise<OrganizerReportResult> {
    return this.organizerReportQuery.execute(organizerId, query, currentUser);
  }
}
