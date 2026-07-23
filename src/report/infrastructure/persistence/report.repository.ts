import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import config from "@src/config/config";
import {
  Booking,
  BookingStatus,
  PaymentStatus,
} from "@src/schemas/booking.schema";
import { Payment } from "@src/schemas/payment.schema";
import { PaymentWebhookEvent } from "@src/schemas/payment-webhook-event.schema";
import {
  RefundProvider,
  RefundRequest,
  RefundRequestStatus,
} from "@src/schemas/refund-request.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { ReportEventScope } from "@src/report/domain/policies/report-scope.policy";
import { toPaginatedResponse } from "@src/report/domain/report-pagination.util";
import { ResolvedReportRange } from "@src/report/domain/report-range.util";
import { RECONCILIATION_CASE_TYPE_CAP } from "@src/report/report.constants";
import {
  CheckInByHourRow,
  CheckInByStaffRow,
  CheckInByZoneRow,
  CheckInReportSummary,
  OrganizerEventBreakdownRow,
  RefundAmountByEventRow,
  RefundAmountByProviderRow,
  RefundReportSummary,
  ReportGroupBy,
  SalesReportEventBreakdownRow,
  SalesReportSummary,
  SalesReportTimeSeriesPoint,
  SalesReportZoneBreakdownRow,
} from "@src/report/domain/types/report.types";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";

type EventIdFilterFragment =
  | { eventId: Types.ObjectId }
  | { eventId: { $in: Types.ObjectId[] } }
  | Record<string, never>;

const GROUP_BY_FORMAT: Record<ReportGroupBy, string> = {
  day: "%Y-%m-%d",
  week: "%G-W%V",
  month: "%Y-%m",
};

const SALE_PAYMENT_STATUSES: PaymentStatus[] = [
  PaymentStatus.PAID,
  PaymentStatus.REFUND_PENDING,
  PaymentStatus.REFUNDED,
];

interface RawEventBreakdown {
  _id: Types.ObjectId;
  grossRevenue: number;
  refundAmount: number;
  ticketsSold: number;
  netRevenue: number;
}
interface RawEventBreakdownFacet {
  data: (RawEventBreakdown & { event?: { title?: string } })[];
  totalCount: { count: number }[];
}

interface RawZoneBreakdown {
  _id: Types.ObjectId;
  grossRevenue: number;
  refundAmount: number;
  ticketsSold: number;
  netRevenue: number;
}
interface RawZoneBreakdownFacet {
  data: (RawZoneBreakdown & {
    zone?: { name?: string; eventId?: Types.ObjectId };
  })[];
  totalCount: { count: number }[];
}

interface RawSalesSummary {
  _id: null;
  grossRevenue: number;
  refundAmount: number;
  ticketsSold: number;
  bookingCount: number;
}

interface RawTimeSeriesPoint {
  _id: string;
  grossRevenue: number;
  refundAmount: number;
  bookingCount: number;
}

interface RawCheckInSummary {
  _id: null;
  totalValidTickets: number;
  checkedInTickets: number;
}

interface RawCheckInByZone {
  _id: Types.ObjectId;
  totalTickets: number;
  checkedInCount: number;
  zone?: { name?: string };
}
interface RawCheckInByZoneFacet {
  data: RawCheckInByZone[];
  totalCount: { count: number }[];
}

interface RawCheckInByStaff {
  _id: Types.ObjectId;
  checkedInCount: number;
  staff?: { fullName?: string };
}
interface RawCheckInByStaffFacet {
  data: RawCheckInByStaff[];
  totalCount: { count: number }[];
}

interface RawRefundByStatus {
  _id: RefundRequestStatus;
  count: number;
}
interface RawRefundSummaryFacet {
  byStatus: RawRefundByStatus[];
  succeededAmount: { total: number }[];
}

interface RawRefundByEvent {
  _id: Types.ObjectId;
  refundAmount: number;
  refundCount: number;
  event?: { title?: string };
}
interface RawRefundByEventFacet {
  data: RawRefundByEvent[];
  totalCount: { count: number }[];
}

interface RawRefundByProvider {
  _id: RefundProvider | null;
  refundAmount: number;
  refundCount: number;
}

export interface ReconciliationPaymentNotConfirmedRow {
  paymentId: string;
  bookingId: string;
  bookingCode: string;
  eventId?: string;
  amount: number;
  detectedAt: Date;
}

export interface ReconciliationBookingNoTicketRow {
  bookingId: string;
  bookingCode: string;
  eventId?: string;
  amount: number;
  detectedAt: Date;
}

export interface ReconciliationBookingNotRefundedRow {
  bookingId: string;
  bookingCode: string;
  eventId?: string;
  amount: number;
  detectedAt: Date;
}

export interface ReconciliationWebhookFailedRow {
  webhookEventId: string;
  provider: string;
  eventType: string;
  errorMessage?: string;
  detectedAt: Date;
}

export interface ReconciliationDuplicatePaymentRow {
  bookingId: string;
  eventId?: string;
  amount: number;
  count: number;
  paymentIds: string[];
  detectedAt: Date;
}

@Injectable()
export class ReportRepository {
  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(RefundRequest.name)
    private readonly refundRequestModel: Model<RefundRequest>,
    @InjectModel(PaymentWebhookEvent.name)
    private readonly webhookEventModel: Model<PaymentWebhookEvent>
  ) {}

  // ---------------------------------------------------------------------
  // Sales report — source of truth is Booking (totalPrice/totalRefunded),
  // not Payment, so gross/net/refund always reconcile: Payment can have
  // multiple failed/duplicate rows per booking, Booking cannot.
  // ---------------------------------------------------------------------

  async querySalesSummary(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId?: string
  ): Promise<SalesReportSummary> {
    const filter = this.buildSaleFilter(scope, range, zoneId);
    const result = await this.bookingModel.aggregate<RawSalesSummary>([
      { $match: filter },
      {
        $group: {
          _id: null,
          grossRevenue: { $sum: "$totalPrice" },
          refundAmount: { $sum: "$totalRefunded" },
          ticketsSold: { $sum: "$quantity" },
          bookingCount: { $sum: 1 },
        },
      },
    ]);

    const row = result[0];
    const grossRevenue = row?.grossRevenue ?? 0;
    const refundAmount = row?.refundAmount ?? 0;
    const bookingCount = row?.bookingCount ?? 0;
    const netRevenue = grossRevenue - refundAmount;

    return {
      grossRevenue,
      netRevenue,
      refundAmount,
      ticketsSold: row?.ticketsSold ?? 0,
      bookingCount,
      averageOrderValue:
        bookingCount === 0 ? 0 : Math.round(netRevenue / bookingCount),
      currency: "vnd",
    };
  }

  async querySalesTimeSeries(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    groupBy: ReportGroupBy,
    zoneId?: string
  ): Promise<SalesReportTimeSeriesPoint[]> {
    const filter = this.buildSaleFilter(scope, range, zoneId);
    const rows = await this.bookingModel.aggregate<RawTimeSeriesPoint>([
      { $match: filter },
      {
        $group: {
          _id: {
            $dateToString: {
              format: GROUP_BY_FORMAT[groupBy],
              date: "$paidAt",
              timezone: config.APP_TIMEZONE,
            },
          },
          grossRevenue: { $sum: "$totalPrice" },
          refundAmount: { $sum: "$totalRefunded" },
          bookingCount: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({
      label: row._id,
      grossRevenue: row.grossRevenue,
      netRevenue: row.grossRevenue - row.refundAmount,
      refundAmount: row.refundAmount,
      bookingCount: row.bookingCount,
    }));
  }

  async querySalesByEvent(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    page: number,
    limit: number
  ): Promise<PaginatedResponse<SalesReportEventBreakdownRow>> {
    const filter = this.buildSaleFilter(scope, range);
    const skip = (page - 1) * limit;

    const [facetResult] =
      await this.bookingModel.aggregate<RawEventBreakdownFacet>([
        { $match: filter },
        {
          $group: {
            _id: "$eventId",
            grossRevenue: { $sum: "$totalPrice" },
            refundAmount: { $sum: "$totalRefunded" },
            ticketsSold: { $sum: "$quantity" },
          },
        },
        {
          $addFields: {
            netRevenue: { $subtract: ["$grossRevenue", "$refundAmount"] },
          },
        },
        { $sort: { netRevenue: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "events",
                  localField: "_id",
                  foreignField: "_id",
                  as: "event",
                },
              },
              {
                $unwind: { path: "$event", preserveNullAndEmptyArrays: true },
              },
            ],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);

    const items: SalesReportEventBreakdownRow[] = (facetResult?.data ?? []).map(
      (row) => ({
        eventId: row._id.toString(),
        eventName: row.event?.title ?? "",
        grossRevenue: row.grossRevenue,
        netRevenue: row.netRevenue,
        refundAmount: row.refundAmount,
        ticketsSold: row.ticketsSold,
      })
    );

    return toPaginatedResponse(
      items,
      page,
      limit,
      facetResult?.totalCount[0]?.count ?? 0
    );
  }

  async querySalesByZone(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId: string | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedResponse<SalesReportZoneBreakdownRow>> {
    const filter = this.buildSaleFilter(scope, range, zoneId);
    const skip = (page - 1) * limit;

    const [facetResult] =
      await this.bookingModel.aggregate<RawZoneBreakdownFacet>([
        { $match: filter },
        {
          $group: {
            _id: "$zoneId",
            grossRevenue: { $sum: "$totalPrice" },
            refundAmount: { $sum: "$totalRefunded" },
            ticketsSold: { $sum: "$quantity" },
          },
        },
        {
          $addFields: {
            netRevenue: { $subtract: ["$grossRevenue", "$refundAmount"] },
          },
        },
        { $sort: { netRevenue: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "zones",
                  localField: "_id",
                  foreignField: "_id",
                  as: "zone",
                },
              },
              { $unwind: { path: "$zone", preserveNullAndEmptyArrays: true } },
            ],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);

    const items: SalesReportZoneBreakdownRow[] = (facetResult?.data ?? []).map(
      (row) => ({
        zoneId: row._id.toString(),
        zoneName: row.zone?.name ?? "",
        eventId: row.zone?.eventId?.toString() ?? "",
        grossRevenue: row.grossRevenue,
        netRevenue: row.netRevenue,
        ticketsSold: row.ticketsSold,
      })
    );

    return toPaginatedResponse(
      items,
      page,
      limit,
      facetResult?.totalCount[0]?.count ?? 0
    );
  }

  // ---------------------------------------------------------------------
  // Check-in report — Ticket is the source of truth. `from`/`to` windows
  // the ticket's `createdAt` (issuance) so the summary population and the
  // check-in breakdowns share one consistent denominator.
  // ---------------------------------------------------------------------

  async queryCheckInSummary(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId?: string
  ): Promise<CheckInReportSummary> {
    const filter = this.buildTicketBaseFilter(scope, range, zoneId);
    const result = await this.ticketModel.aggregate<RawCheckInSummary>([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalValidTickets: { $sum: 1 },
          checkedInTickets: {
            $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] },
          },
        },
      },
    ]);

    const totalValidTickets = result[0]?.totalValidTickets ?? 0;
    const checkedInTickets = result[0]?.checkedInTickets ?? 0;

    return {
      totalValidTickets,
      checkedInTickets,
      noShowCount: totalValidTickets - checkedInTickets,
      checkInRate:
        totalValidTickets === 0
          ? 0
          : Math.round((checkedInTickets / totalValidTickets) * 10000) / 100,
    };
  }

  async queryCheckInByHour(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId?: string
  ): Promise<CheckInByHourRow[]> {
    const filter: FilterQuery<Ticket> = {
      ...this.buildTicketBaseFilter(scope, range, zoneId),
      status: "used",
      checkedInAt: { $exists: true, $ne: null },
    };

    const rows = await this.ticketModel.aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: filter },
      {
        $group: {
          _id: {
            $dateToString: {
              format: "%Y-%m-%d %H:00",
              date: "$checkedInAt",
              timezone: config.APP_TIMEZONE,
            },
          },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    return rows.map((row) => ({ hour: row._id, count: row.count }));
  }

  async queryCheckInByZone(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId: string | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedResponse<CheckInByZoneRow>> {
    const filter = this.buildTicketBaseFilter(scope, range, zoneId);
    const skip = (page - 1) * limit;

    const [facetResult] =
      await this.ticketModel.aggregate<RawCheckInByZoneFacet>([
        { $match: filter },
        {
          $group: {
            _id: "$zoneId",
            totalTickets: { $sum: 1 },
            checkedInCount: {
              $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] },
            },
          },
        },
        { $sort: { totalTickets: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "zones",
                  localField: "_id",
                  foreignField: "_id",
                  as: "zone",
                },
              },
              { $unwind: { path: "$zone", preserveNullAndEmptyArrays: true } },
            ],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);

    const items: CheckInByZoneRow[] = (facetResult?.data ?? []).map((row) => ({
      zoneId: row._id.toString(),
      zoneName: row.zone?.name ?? "",
      totalTickets: row.totalTickets,
      checkedInCount: row.checkedInCount,
      checkInRate:
        row.totalTickets === 0
          ? 0
          : Math.round((row.checkedInCount / row.totalTickets) * 10000) / 100,
    }));

    return toPaginatedResponse(
      items,
      page,
      limit,
      facetResult?.totalCount[0]?.count ?? 0
    );
  }

  async queryCheckInByStaff(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId: string | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedResponse<CheckInByStaffRow>> {
    const filter: FilterQuery<Ticket> = {
      ...this.buildTicketBaseFilter(scope, range, zoneId),
      status: "used",
      checkedInBy: { $exists: true, $ne: null },
    };
    const skip = (page - 1) * limit;

    const [facetResult] =
      await this.ticketModel.aggregate<RawCheckInByStaffFacet>([
        { $match: filter },
        {
          $group: {
            _id: "$checkedInBy",
            checkedInCount: { $sum: 1 },
          },
        },
        { $sort: { checkedInCount: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "users",
                  localField: "_id",
                  foreignField: "_id",
                  as: "staff",
                },
              },
              { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },
            ],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);

    const items: CheckInByStaffRow[] = (facetResult?.data ?? []).map((row) => ({
      staffId: row._id.toString(),
      staffName: row.staff?.fullName ?? "",
      checkedInCount: row.checkedInCount,
    }));

    return toPaginatedResponse(
      items,
      page,
      limit,
      facetResult?.totalCount[0]?.count ?? 0
    );
  }

  // ---------------------------------------------------------------------
  // Refund report
  // ---------------------------------------------------------------------

  async queryRefundSummary(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    provider?: RefundProvider
  ): Promise<RefundReportSummary> {
    const filter = this.buildRefundFilter(scope, range, provider);

    const [facetResult] =
      await this.refundRequestModel.aggregate<RawRefundSummaryFacet>([
        { $match: filter },
        {
          $facet: {
            byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            succeededAmount: [
              { $match: { status: RefundRequestStatus.SUCCEEDED } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ],
          },
        },
      ]);

    const counts = new Map<RefundRequestStatus, number>();
    for (const row of facetResult?.byStatus ?? []) {
      counts.set(row._id, row.count);
    }

    const requested = counts.get(RefundRequestStatus.REQUESTED) ?? 0;
    const processing = counts.get(RefundRequestStatus.PROCESSING) ?? 0;
    const succeeded = counts.get(RefundRequestStatus.SUCCEEDED) ?? 0;
    const failed = counts.get(RefundRequestStatus.FAILED) ?? 0;
    const rejected = counts.get(RefundRequestStatus.REJECTED) ?? 0;

    return {
      requested,
      approved: processing + succeeded + failed,
      rejected,
      succeeded,
      failed,
      totalRefundAmount: facetResult?.succeededAmount[0]?.total ?? 0,
    };
  }

  async queryRefundByEvent(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    provider: RefundProvider | undefined,
    page: number,
    limit: number
  ): Promise<PaginatedResponse<RefundAmountByEventRow>> {
    const filter: FilterQuery<RefundRequest> = {
      ...this.buildRefundFilter(scope, range, provider),
      status: RefundRequestStatus.SUCCEEDED,
    };
    const skip = (page - 1) * limit;

    const [facetResult] =
      await this.refundRequestModel.aggregate<RawRefundByEventFacet>([
        { $match: filter },
        {
          $group: {
            _id: "$eventId",
            refundAmount: { $sum: "$amount" },
            refundCount: { $sum: 1 },
          },
        },
        { $sort: { refundAmount: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "events",
                  localField: "_id",
                  foreignField: "_id",
                  as: "event",
                },
              },
              { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
            ],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);

    const items: RefundAmountByEventRow[] = (facetResult?.data ?? []).map(
      (row) => ({
        eventId: row._id.toString(),
        eventName: row.event?.title ?? "",
        refundAmount: row.refundAmount,
        refundCount: row.refundCount,
      })
    );

    return toPaginatedResponse(
      items,
      page,
      limit,
      facetResult?.totalCount[0]?.count ?? 0
    );
  }

  async queryRefundByProvider(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    provider?: RefundProvider
  ): Promise<RefundAmountByProviderRow[]> {
    const filter: FilterQuery<RefundRequest> = {
      ...this.buildRefundFilter(scope, range, provider),
      status: RefundRequestStatus.SUCCEEDED,
    };

    const rows = await this.refundRequestModel.aggregate<RawRefundByProvider>([
      { $match: filter },
      {
        $group: {
          _id: "$provider",
          refundAmount: { $sum: "$amount" },
          refundCount: { $sum: 1 },
        },
      },
      { $sort: { refundAmount: -1 } },
    ]);

    return rows.map((row) => ({
      provider: row._id ?? "unknown",
      refundAmount: row.refundAmount,
      refundCount: row.refundCount,
    }));
  }

  // ---------------------------------------------------------------------
  // Payment reconciliation — each case type is capped at
  // RECONCILIATION_CASE_TYPE_CAP so an unhealthy system can't force an
  // unbounded aggregation; summary counts still use `countDocuments`.
  // ---------------------------------------------------------------------

  async queryPaymentSucceededBookingNotConfirmed(
    scope: ReportEventScope,
    range: ResolvedReportRange
  ): Promise<ReconciliationPaymentNotConfirmedRow[]> {
    const eventFilter = this.buildEventIdFragment(scope);
    const rows = await this.paymentModel.aggregate<{
      _id: Types.ObjectId;
      bookingId: Types.ObjectId;
      eventId?: Types.ObjectId;
      amount: number;
      createdAt: Date;
      booking: { bookingCode: string; status: BookingStatus };
    }>([
      {
        $match: {
          status: "succeeded",
          isDeleted: false,
          createdAt: { $gte: range.fromDate, $lte: range.toDate },
          ...eventFilter,
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "bookingId",
          foreignField: "_id",
          as: "booking",
        },
      },
      { $unwind: "$booking" },
      { $match: { "booking.status": { $ne: BookingStatus.CONFIRMED } } },
      { $limit: RECONCILIATION_CASE_TYPE_CAP },
      {
        $project: {
          _id: 1,
          bookingId: 1,
          eventId: 1,
          amount: 1,
          createdAt: 1,
          "booking.bookingCode": 1,
          "booking.status": 1,
        },
      },
    ]);

    return rows.map((row) => ({
      paymentId: row._id.toString(),
      bookingId: row.bookingId.toString(),
      bookingCode: row.booking.bookingCode,
      eventId: row.eventId?.toString(),
      amount: row.amount,
      detectedAt: row.createdAt,
    }));
  }

  async queryBookingPaidWithoutTicket(
    scope: ReportEventScope,
    range: ResolvedReportRange
  ): Promise<ReconciliationBookingNoTicketRow[]> {
    const eventFilter = this.buildEventIdFragment(scope);
    const rows = await this.bookingModel.aggregate<{
      _id: Types.ObjectId;
      bookingCode: string;
      eventId: Types.ObjectId;
      totalPrice: number;
      paidAt: Date;
    }>([
      {
        $match: {
          paymentStatus: PaymentStatus.PAID,
          isDeleted: false,
          paidAt: { $gte: range.fromDate, $lte: range.toDate },
          ...eventFilter,
        },
      },
      {
        $lookup: {
          from: "tickets",
          let: { bookingId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$bookingId", "$$bookingId"] },
                    { $eq: ["$isDeleted", false] },
                  ],
                },
              },
            },
            { $limit: 1 },
          ],
          as: "tickets",
        },
      },
      { $match: { tickets: { $size: 0 } } },
      { $limit: RECONCILIATION_CASE_TYPE_CAP },
      {
        $project: {
          _id: 1,
          bookingCode: 1,
          eventId: 1,
          totalPrice: 1,
          paidAt: 1,
        },
      },
    ]);

    return rows.map((row) => ({
      bookingId: row._id.toString(),
      bookingCode: row.bookingCode,
      eventId: row.eventId?.toString(),
      amount: row.totalPrice,
      detectedAt: row.paidAt,
    }));
  }

  async queryBookingCancelledNotRefunded(
    scope: ReportEventScope,
    range: ResolvedReportRange
  ): Promise<ReconciliationBookingNotRefundedRow[]> {
    const eventFilter = this.buildEventIdFragment(scope);
    const rows = await this.bookingModel.aggregate<{
      _id: Types.ObjectId;
      bookingCode: string;
      eventId: Types.ObjectId;
      totalPrice: number;
      totalRefunded: number;
      cancelledAt: Date;
    }>([
      {
        $match: {
          status: BookingStatus.CANCELLED,
          isDeleted: false,
          paidAt: { $exists: true, $ne: null },
          cancelledAt: { $gte: range.fromDate, $lte: range.toDate },
          paymentStatus: { $ne: PaymentStatus.REFUNDED },
          $expr: { $lt: ["$totalRefunded", "$totalPrice"] },
          ...eventFilter,
        },
      },
      { $limit: RECONCILIATION_CASE_TYPE_CAP },
      {
        $project: {
          _id: 1,
          bookingCode: 1,
          eventId: 1,
          totalPrice: 1,
          totalRefunded: 1,
          cancelledAt: 1,
        },
      },
    ]);

    return rows.map((row) => ({
      bookingId: row._id.toString(),
      bookingCode: row.bookingCode,
      eventId: row.eventId?.toString(),
      amount: row.totalPrice - row.totalRefunded,
      detectedAt: row.cancelledAt,
    }));
  }

  /**
   * PaymentWebhookEvent has no link to our internal Event id (its `eventId`
   * field is the provider's webhook event id) or Booking, so this case type
   * cannot be attributed to a specific event — callers MUST only invoke this
   * for an unrestricted admin scope (see PaymentReconciliationQueryService).
   */
  async queryPaymentWebhookFailed(
    range: ResolvedReportRange
  ): Promise<ReconciliationWebhookFailedRow[]> {
    const rows = await this.webhookEventModel
      .find({
        status: "failed",
        createdAt: { $gte: range.fromDate, $lte: range.toDate },
      })
      .select("provider eventType errorMessage createdAt")
      .sort({ createdAt: -1 })
      .limit(RECONCILIATION_CASE_TYPE_CAP)
      .lean<
        {
          _id: Types.ObjectId;
          provider: string;
          eventType: string;
          errorMessage?: string;
          createdAt: Date;
        }[]
      >();

    return rows.map((row) => ({
      webhookEventId: row._id.toString(),
      provider: row.provider,
      eventType: row.eventType,
      errorMessage: row.errorMessage,
      detectedAt: row.createdAt,
    }));
  }

  async queryDuplicatePaymentRecords(
    scope: ReportEventScope,
    range: ResolvedReportRange
  ): Promise<ReconciliationDuplicatePaymentRow[]> {
    const eventFilter = this.buildEventIdFragment(scope);
    const rows = await this.paymentModel.aggregate<{
      _id: Types.ObjectId;
      count: number;
      paymentIds: string[];
      eventId?: Types.ObjectId;
      amount: number;
      latestCreatedAt: Date;
    }>([
      {
        $match: {
          status: "succeeded",
          isDeleted: false,
          createdAt: { $gte: range.fromDate, $lte: range.toDate },
          ...eventFilter,
        },
      },
      {
        $group: {
          _id: "$bookingId",
          count: { $sum: 1 },
          paymentIds: { $push: { $toString: "$_id" } },
          eventId: { $first: "$eventId" },
          amount: { $sum: "$amount" },
          latestCreatedAt: { $max: "$createdAt" },
        },
      },
      { $match: { count: { $gt: 1 } } },
      { $limit: RECONCILIATION_CASE_TYPE_CAP },
    ]);

    return rows.map((row) => ({
      bookingId: row._id.toString(),
      eventId: row.eventId?.toString(),
      amount: row.amount,
      count: row.count,
      paymentIds: row.paymentIds,
      detectedAt: row.latestCreatedAt,
    }));
  }

  // ---------------------------------------------------------------------
  // Organizer report
  // ---------------------------------------------------------------------

  async queryOrganizerEventBreakdown(
    eventIds: Types.ObjectId[],
    range: ResolvedReportRange,
    page: number,
    limit: number
  ): Promise<PaginatedResponse<OrganizerEventBreakdownRow>> {
    if (eventIds.length === 0) {
      return toPaginatedResponse([], page, limit, 0);
    }

    const skip = (page - 1) * limit;
    const saleFilter: FilterQuery<Booking> = {
      isDeleted: false,
      paidAt: { $gte: range.fromDate, $lte: range.toDate },
      paymentStatus: { $in: SALE_PAYMENT_STATUSES },
      eventId: { $in: eventIds },
    };

    const [facetResult] =
      await this.bookingModel.aggregate<RawEventBreakdownFacet>([
        { $match: saleFilter },
        {
          $group: {
            _id: "$eventId",
            grossRevenue: { $sum: "$totalPrice" },
            refundAmount: { $sum: "$totalRefunded" },
            ticketsSold: { $sum: "$quantity" },
          },
        },
        {
          $addFields: {
            netRevenue: { $subtract: ["$grossRevenue", "$refundAmount"] },
          },
        },
        { $sort: { netRevenue: -1, _id: 1 } },
        {
          $facet: {
            data: [
              { $skip: skip },
              { $limit: limit },
              {
                $lookup: {
                  from: "events",
                  localField: "_id",
                  foreignField: "_id",
                  as: "event",
                },
              },
              { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
            ],
            totalCount: [{ $count: "count" }],
          },
        },
      ]);

    const eventIdList = (facetResult?.data ?? []).map((row) => row._id);
    const checkedInByEvent = await this.ticketModel.aggregate<{
      _id: Types.ObjectId;
      checkedInCount: number;
    }>([
      {
        $match: {
          eventId: { $in: eventIdList },
          status: "used",
          isDeleted: false,
        },
      },
      { $group: { _id: "$eventId", checkedInCount: { $sum: 1 } } },
    ]);
    const checkedInMap = new Map(
      checkedInByEvent.map((row) => [row._id.toString(), row.checkedInCount])
    );

    const items: OrganizerEventBreakdownRow[] = (facetResult?.data ?? []).map(
      (row) => ({
        eventId: row._id.toString(),
        eventName: row.event?.title ?? "",
        grossRevenue: row.grossRevenue,
        netRevenue: row.netRevenue,
        ticketsSold: row.ticketsSold,
        checkedInCount: checkedInMap.get(row._id.toString()) ?? 0,
      })
    );

    return toPaginatedResponse(
      items,
      page,
      limit,
      facetResult?.totalCount[0]?.count ?? 0
    );
  }

  // ---------------------------------------------------------------------
  // Shared filter builders
  // ---------------------------------------------------------------------

  private buildSaleFilter(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId?: string
  ): FilterQuery<Booking> {
    return {
      isDeleted: false,
      paidAt: { $gte: range.fromDate, $lte: range.toDate },
      paymentStatus: { $in: SALE_PAYMENT_STATUSES },
      ...this.buildEventIdFragment(scope),
      ...(zoneId && { zoneId: new Types.ObjectId(zoneId) }),
    };
  }

  private buildTicketBaseFilter(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    zoneId?: string
  ): FilterQuery<Ticket> {
    return {
      isDeleted: false,
      createdAt: { $gte: range.fromDate, $lte: range.toDate },
      status: { $in: ["valid", "used"] },
      ...this.buildEventIdFragment(scope),
      ...(zoneId && { zoneId: new Types.ObjectId(zoneId) }),
    };
  }

  private buildRefundFilter(
    scope: ReportEventScope,
    range: ResolvedReportRange,
    provider?: RefundProvider
  ): FilterQuery<RefundRequest> {
    return {
      isDeleted: false,
      createdAt: { $gte: range.fromDate, $lte: range.toDate },
      ...this.buildEventIdFragment(scope),
      ...(provider && { provider }),
    };
  }

  private buildEventIdFragment(scope: ReportEventScope): EventIdFilterFragment {
    if (scope.eventIdEq) return { eventId: scope.eventIdEq };
    if (scope.eventIdIn) return { eventId: { $in: scope.eventIdIn } };
    return {};
  }
}
