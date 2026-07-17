import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import config from "@src/config/config";
import { DashboardOverviewDto } from "@src/statistical/dto/dashboard.dto";
import { Booking } from "@src/schemas/booking.schema";
import { Event } from "@src/schemas/event.schema";
import { Payment } from "@src/schemas/payment.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import {
  CheckInZoneStatistics,
  HotEventByRevenue,
  RevenueGroupBy,
  RevenueStatisticsResult,
  TopPotentialCustomer,
  TopSellingMetric,
} from "@src/statistical/domain/types/statistical.types";
import { RevenueStatisticsByEventResponseDto } from "@src/statistical/dto/dashboard.dto";
import { DateTime } from "luxon";
import { FilterQuery, Model, Types } from "mongoose";

type TotalResult = { _id: null; total: number };

type PaymentTotalStats = { _id: null; revenue: number; refunded: number };
type PaymentOverviewFacet = {
  total: PaymentTotalStats[];
  currentMonth: TotalResult[];
  previousMonth: TotalResult[];
};

type TicketTotalStats = { _id: null; sold: number; checkedIn: number };
type TicketMonthStats = { _id: null; ticketsSold: number; checkedIn: number };
type TicketOverviewFacet = {
  total: TicketTotalStats[];
  currentMonth: TicketMonthStats[];
  previousMonth: TicketMonthStats[];
};

type BookingCountResult = { count: number };
type BookingOverviewFacet = {
  total: BookingCountResult[];
  paid: BookingCountResult[];
};

type RevenueGroupResult = {
  _id: { year: number; month: number; day?: number };
  totalRevenue: number;
  count: number;
};

type DateRangeCondition = { $gte: Date; $lte: Date };

type NetRevenueAccumulator = {
  $sum: {
    $subtract: [string, { $ifNull: [string, number] }];
  };
};

interface MonthBoundaries {
  startOfCurrentMonth: Date;
  startOfNextMonth: Date;
  startOfPreviousMonth: Date;
}

interface PaymentFilter {
  status?: { $in: string[] };
  isDeleted?: boolean;
  eventId?: Types.ObjectId;
  createdAt?: DateRangeCondition;
}

@Injectable()
export class StatisticalRepository {
  private readonly successStatuses: string[] = [
    "succeeded",
    "partially_refunded",
  ];

  constructor(
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(Payment.name) private readonly paymentModel: Model<Payment>,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(Event.name) private readonly eventModel: Model<Event>
  ) {}

  queryHotEventsByRevenue(): Promise<HotEventByRevenue[]> {
    return this.paymentModel.aggregate<HotEventByRevenue>([
      {
        $match: {
          status: { $in: this.successStatuses },
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: "$eventId",
          totalRevenue: this.netRevenue(),
          totalPayments: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "events",
          localField: "_id",
          foreignField: "_id",
          as: "event",
        },
      },
      { $unwind: "$event" },
      {
        $project: {
          _id: 0,
          id: "$_id",
          title: "$event.title",
          thumbnail: "$event.thumbnail",
          totalRevenue: 1,
          totalPayments: 1,
        },
      },
    ]);
  }

  async queryOverviewStatistics(
    eventId?: string,
    startDate?: string,
    endDate?: string
  ): Promise<DashboardOverviewDto> {
    const { startOfCurrentMonth, startOfNextMonth, startOfPreviousMonth } =
      this.getMonthBoundaries();

    const eventFilter = eventId ? { eventId: new Types.ObjectId(eventId) } : {};

    let dateRangeCondition: DateRangeCondition | undefined;
    if (startDate && endDate) {
      dateRangeCondition = {
        $gte: new Date(startDate),
        $lte: this.endOfLocalDay(endDate),
      };
    }
    const dateRangeStage = dateRangeCondition
      ? [{ $match: { createdAt: dateRangeCondition } }]
      : [];

    const [paymentFacet, ticketFacet, bookingFacet] = await Promise.all([
      this.paymentModel.aggregate<PaymentOverviewFacet>([
        {
          $match: {
            status: { $in: this.successStatuses },
            isDeleted: false,
            ...eventFilter,
          },
        },
        {
          $facet: {
            total: [
              ...dateRangeStage,
              {
                $group: {
                  _id: null,
                  revenue: this.netRevenue(),
                  refunded: { $sum: { $ifNull: ["$refundAmount", 0] } },
                },
              },
            ],
            currentMonth: [
              {
                $match: {
                  createdAt: {
                    $gte: startOfCurrentMonth,
                    $lt: startOfNextMonth,
                  },
                },
              },
              { $group: { _id: null, total: this.netRevenue() } },
            ],
            previousMonth: [
              {
                $match: {
                  createdAt: {
                    $gte: startOfPreviousMonth,
                    $lt: startOfCurrentMonth,
                  },
                },
              },
              { $group: { _id: null, total: this.netRevenue() } },
            ],
          },
        },
      ]),

      this.ticketModel.aggregate<TicketOverviewFacet>([
        {
          $match: {
            status: { $in: ["valid", "used"] },
            isDeleted: false,
            ...eventFilter,
          },
        },
        {
          $facet: {
            total: [
              ...dateRangeStage,
              {
                $group: {
                  _id: null,
                  sold: { $sum: 1 },
                  checkedIn: {
                    $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] },
                  },
                },
              },
            ],
            currentMonth: [
              {
                $match: {
                  createdAt: {
                    $gte: startOfCurrentMonth,
                    $lt: startOfNextMonth,
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  ticketsSold: { $sum: 1 },
                  checkedIn: {
                    $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] },
                  },
                },
              },
            ],
            previousMonth: [
              {
                $match: {
                  createdAt: {
                    $gte: startOfPreviousMonth,
                    $lt: startOfCurrentMonth,
                  },
                },
              },
              {
                $group: {
                  _id: null,
                  ticketsSold: { $sum: 1 },
                  checkedIn: {
                    $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] },
                  },
                },
              },
            ],
          },
        },
      ]),

      this.bookingModel.aggregate<BookingOverviewFacet>([
        { $match: { isDeleted: false, ...eventFilter } },
        {
          $facet: {
            total: [
              ...(dateRangeCondition
                ? [{ $match: { createdAt: dateRangeCondition } }]
                : []),
              { $count: "count" },
            ],
            paid: [
              {
                $match: {
                  ...(dateRangeCondition && {
                    createdAt: dateRangeCondition,
                  }),
                  paymentStatus: "paid",
                },
              },
              { $count: "count" },
            ],
          },
        },
      ]),
    ]);

    const totalRevenue = paymentFacet[0]?.total[0]?.revenue ?? 0;
    const totalRefundedAmount = paymentFacet[0]?.total[0]?.refunded ?? 0;
    const currentMonthRevenue = paymentFacet[0]?.currentMonth[0]?.total ?? 0;
    const previousMonthRevenue = paymentFacet[0]?.previousMonth[0]?.total ?? 0;

    const totalTicketsSold = ticketFacet[0]?.total[0]?.sold ?? 0;
    const totalCheckedIn = ticketFacet[0]?.total[0]?.checkedIn ?? 0;
    const currentMonthTicketsSold =
      ticketFacet[0]?.currentMonth[0]?.ticketsSold ?? 0;
    const previousMonthTicketsSold =
      ticketFacet[0]?.previousMonth[0]?.ticketsSold ?? 0;
    const currentMonthCheckedIn =
      ticketFacet[0]?.currentMonth[0]?.checkedIn ?? 0;
    const previousMonthCheckedIn =
      ticketFacet[0]?.previousMonth[0]?.checkedIn ?? 0;

    const totalBookings = bookingFacet[0]?.total[0]?.count ?? 0;
    const totalPaidBookings = bookingFacet[0]?.paid[0]?.count ?? 0;

    const pct = (curr: number, prev: number) =>
      prev === 0 ? (curr === 0 ? 0 : 100) : ((curr - prev) / prev) * 100;

    return {
      totalRevenue,
      totalTicketsSold,
      totalBookings,
      totalPaidBookings,
      totalCheckedIn,
      totalRefundedAmount,
      currentMonthRevenue,
      previousMonthRevenue,
      revenueDifference: currentMonthRevenue - previousMonthRevenue,
      percentageChange: pct(currentMonthRevenue, previousMonthRevenue),
      currentMonthTicketsSold,
      previousMonthTicketsSold,
      ticketsSoldPercentageChange: pct(
        currentMonthTicketsSold,
        previousMonthTicketsSold
      ),
      currentMonthCheckedIn,
      previousMonthCheckedIn,
      checkedInPercentageChange: pct(
        currentMonthCheckedIn,
        previousMonthCheckedIn
      ),
    };
  }

  async queryRevenueStatistics(
    eventId: string | undefined,
    from: string,
    to: string,
    groupBy: RevenueGroupBy
  ): Promise<RevenueStatisticsResult> {
    const toDate = new Date(to);
    toDate.setHours(23, 59, 59, 999);

    const matchFilter: PaymentFilter & {
      createdAt: DateRangeCondition;
    } = {
      status: { $in: this.successStatuses },
      isDeleted: false,
      createdAt: { $gte: new Date(from), $lte: toDate },
      ...(eventId && { eventId: new Types.ObjectId(eventId) }),
    };

    const zone = config.APP_TIMEZONE;

    const groupId: Record<string, unknown> = {
      year: { $year: { date: "$createdAt", timezone: zone } },
      month: { $month: { date: "$createdAt", timezone: zone } },
    };
    if (groupBy === "day") {
      groupId.day = { $dayOfMonth: { date: "$createdAt", timezone: zone } };
    }

    const revenueData = await this.paymentModel.aggregate<RevenueGroupResult>([
      { $match: matchFilter },
      {
        $group: {
          _id: groupId,
          totalRevenue: this.netRevenue(),
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
    ]);

    const data = revenueData.map((item) => {
      const label =
        groupBy === "day"
          ? `${item._id.year}-${String(item._id.month).padStart(2, "0")}-${String(item._id.day ?? 1).padStart(2, "0")}`
          : `${item._id.year}-${String(item._id.month).padStart(2, "0")}`;
      return { label, revenue: item.totalRevenue, count: item.count };
    });

    return { data };
  }

  async queryRevenueStatisticsByEvent(
    eventId: string
  ): Promise<RevenueStatisticsByEventResponseDto> {
    const eventFilter: PaymentFilter = {
      eventId: new Types.ObjectId(eventId),
      status: { $in: this.successStatuses },
      isDeleted: false,
    };

    const [event, totalRevenueResult, ticketsSold] = await Promise.all([
      this.eventModel
        .findById(eventId)
        .select("title")
        .lean<{ title?: string }>()
        .exec(),
      this.paymentModel.aggregate<TotalResult>([
        { $match: eventFilter },
        { $group: { _id: null, total: this.netRevenue() } },
      ]),
      this.ticketModel.countDocuments({
        eventId: new Types.ObjectId(eventId),
        status: { $in: ["valid", "used"] },
        isDeleted: false,
      } as FilterQuery<Ticket>),
    ]);

    if (!event) throw new NotFoundException("Event not found");

    return {
      eventId,
      eventName: event.title ?? "",
      totalRevenue: totalRevenueResult[0]?.total ?? 0,
      ticketsSold,
    };
  }

  queryTopSellingEvents(
    by: TopSellingMetric
  ): Promise<RevenueStatisticsByEventResponseDto[]> {
    if (by === "tickets") {
      return this.ticketModel.aggregate<RevenueStatisticsByEventResponseDto>([
        { $match: { status: { $in: ["valid", "used"] }, isDeleted: false } },
        { $group: { _id: "$eventId", ticketsSold: { $sum: 1 } } },
        { $sort: { ticketsSold: -1 } },
        { $limit: 5 },
        {
          $lookup: {
            from: "payments",
            let: { eid: "$_id" },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ["$eventId", "$$eid"] },
                      { $in: ["$status", this.successStatuses] },
                      { $eq: ["$isDeleted", false] },
                    ],
                  },
                },
              },
              { $group: { _id: null, netRevenue: this.netRevenue() } },
            ],
            as: "revenueData",
          },
        },
        {
          $lookup: {
            from: "events",
            localField: "_id",
            foreignField: "_id",
            as: "event",
          },
        },
        { $unwind: "$event" },
        {
          $project: {
            _id: 0,
            eventId: "$_id",
            eventName: "$event.title",
            ticketsSold: 1,
            totalRevenue: {
              $ifNull: [{ $arrayElemAt: ["$revenueData.netRevenue", 0] }, 0],
            },
          },
        },
      ]);
    }

    return this.paymentModel.aggregate<RevenueStatisticsByEventResponseDto>([
      { $match: { status: { $in: this.successStatuses }, isDeleted: false } },
      { $group: { _id: "$eventId", totalRevenue: this.netRevenue() } },
      { $sort: { totalRevenue: -1 } },
      { $limit: 5 },
      {
        $lookup: {
          from: "tickets",
          let: { eid: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$eventId", "$$eid"] },
                    { $in: ["$status", ["valid", "used"]] },
                    { $eq: ["$isDeleted", false] },
                  ],
                },
              },
            },
            { $count: "total" },
          ],
          as: "ticketData",
        },
      },
      {
        $lookup: {
          from: "events",
          localField: "_id",
          foreignField: "_id",
          as: "event",
        },
      },
      { $unwind: "$event" },
      {
        $project: {
          _id: 0,
          eventId: "$_id",
          eventName: "$event.title",
          totalRevenue: 1,
          ticketsSold: {
            $ifNull: [{ $arrayElemAt: ["$ticketData.total", 0] }, 0],
          },
        },
      },
    ]);
  }

  queryTopPotentialCustomers(): Promise<TopPotentialCustomer[]> {
    return this.bookingModel.aggregate<TopPotentialCustomer>([
      { $match: { paymentStatus: "paid", isDeleted: false } },
      {
        $group: {
          _id: "$userId",
          totalBookings: { $sum: 1 },
          totalAmountSpent: { $sum: "$totalPrice" },
        },
      },
      { $sort: { totalAmountSpent: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "userInfo",
        },
      },
      { $unwind: "$userInfo" },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          name: "$userInfo.name",
          email: "$userInfo.email",
          totalBookings: 1,
          totalAmountSpent: 1,
        },
      },
    ]);
  }

  queryCheckInZones(eventId: string): Promise<CheckInZoneStatistics[]> {
    return this.ticketModel.aggregate<CheckInZoneStatistics>([
      {
        $match: {
          eventId: new Types.ObjectId(eventId),
          isDeleted: false,
        },
      },
      {
        $group: {
          _id: "$zoneId",
          totalTickets: { $sum: 1 },
          checkedInCount: {
            $sum: { $cond: [{ $eq: ["$status", "used"] }, 1, 0] },
          },
        },
      },
      {
        $lookup: {
          from: "zones",
          localField: "_id",
          foreignField: "_id",
          as: "zone",
        },
      },
      { $unwind: "$zone" },
      {
        $project: {
          _id: 0,
          zoneId: "$_id",
          zoneName: "$zone.name",
          price: "$zone.price",
          totalTickets: 1,
          checkedInCount: 1,
          notCheckedIn: { $subtract: ["$totalTickets", "$checkedInCount"] },
          checkInRate: {
            $cond: [
              { $eq: ["$totalTickets", 0] },
              0,
              {
                $multiply: [
                  { $divide: ["$checkedInCount", "$totalTickets"] },
                  100,
                ],
              },
            ],
          },
        },
      },
      { $sort: { zoneName: 1 } },
    ]);
  }

  private netRevenue(): NetRevenueAccumulator {
    return {
      $sum: {
        $subtract: ["$amount", { $ifNull: ["$refundAmount", 0] }],
      },
    };
  }

  private getMonthBoundaries(): MonthBoundaries {
    const tz = config.APP_TIMEZONE;
    const zone = /^[+-]\d{2}:\d{2}$/.test(tz) ? `UTC${tz}` : tz;
    const now = DateTime.now().setZone(zone);
    return {
      startOfCurrentMonth: now.startOf("month").toUTC().toJSDate(),
      startOfNextMonth: now
        .plus({ months: 1 })
        .startOf("month")
        .toUTC()
        .toJSDate(),
      startOfPreviousMonth: now
        .minus({ months: 1 })
        .startOf("month")
        .toUTC()
        .toJSDate(),
    };
  }

  private endOfLocalDay(value: string): Date {
    const end = new Date(value);
    end.setHours(23, 59, 59, 999);
    return end;
  }
}
