import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DashboardOverviewDto, RevenueStatisticsByEventResponseDto } from './dto/dashboard.dto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Booking } from '@src/schemas/booking.schema';
import { Payment } from '@src/schemas/payment.schema';
import { Ticket } from '@src/schemas/ticket.schema';
import { Event } from '@src/schemas/event.schema';
@Injectable()
export class StatisticalService {
    constructor(
        @InjectModel(Booking.name) private bookingModel: Model<Booking>,
        @InjectModel(Payment.name) private paymentModel: Model<Payment>,
        @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
        @InjectModel(Event.name) private eventModel: Model<Event>,
    ) { }

    async getHotEventsByRevenue() {
        return this.paymentModel.aggregate([
            {
                $match: {
                    status: 'succeeded',
                    isDeleted: false,
                },
            },
            {
                $group: {
                    _id: '$eventId',
                    totalRevenue: { $sum: '$amount' },
                    totalPayments: { $sum: 1 },
                },
            },
            {
                $sort: { totalRevenue: -1 },
            },
            { $limit: 5 },
            {
                $lookup: {
                    from: 'events',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'event',
                },
            },
            { $unwind: '$event' },
            {
                $project: {
                    _id: 0,
                    eventId: '$_id',
                    eventName: '$event.title',
                    totalRevenue: 1,
                    totalPayments: 1,
                },
            },
        ]);
    }

    async getOverviewStatistics(
        eventId?: string,
        startDate?: string,
        endDate?: string,
    ): Promise<DashboardOverviewDto> {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();

        const startOfCurrentMonth = new Date(Date.UTC(year, month, 1));
        const startOfNextMonth = new Date(Date.UTC(year, month + 1, 1));
        const startOfPreviousMonth = new Date(Date.UTC(year, month - 1, 1));

        if (eventId && !Types.ObjectId.isValid(eventId)) {
            throw new BadRequestException('Invalid event ID format');
        }

        const bookingFilter: any = {};
        const paymentFilter: any = {};
        const ticketFilter: any = { isDeleted: false };

        if (eventId) {
            const eventObjectId = new Types.ObjectId(eventId);
            bookingFilter.eventId = eventObjectId;
            paymentFilter.eventId = eventObjectId;
            ticketFilter.eventId = eventObjectId;
        }

        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            bookingFilter.createdAt = { $gte: start, $lte: end };
            paymentFilter.createdAt = { $gte: start, $lte: end };
            ticketFilter.createdAt = { $gte: start, $lte: end };
        }

        const comparisonPaymentFilter: any = { status: 'succeeded', isDeleted: false };
        const comparisonTicketFilter: any = { isDeleted: false, status: { $in: ['valid', 'used'] } };
        if (eventId) {
            comparisonPaymentFilter.eventId = new Types.ObjectId(eventId);
            comparisonTicketFilter.eventId = new Types.ObjectId(eventId);
        }

        const [
            totalRevenueResult,
            totalTicketsSold,
            totalBookings,
            totalPaidBookings,
            totalCheckedIn,
            revenueComparisonResult,
            ticketComparisonResult,
        ] = await Promise.all([
            this.paymentModel.aggregate([
                { $match: { ...paymentFilter, status: 'succeeded', isDeleted: false } },
                { $group: { _id: null, total: { $sum: '$amount' } } },
            ]),

            this.ticketModel.countDocuments({
                ...ticketFilter,
                status: { $in: ['valid', 'used'] },
            }),

            this.bookingModel.countDocuments(bookingFilter),

            this.bookingModel.countDocuments({
                ...bookingFilter,
                paymentStatus: 'paid',
            }),

            this.ticketModel.countDocuments({
                ...ticketFilter,
                status: 'used',
            }),

            this.paymentModel.aggregate([
                { $match: comparisonPaymentFilter },
                {
                    $facet: {
                        currentMonth: [
                            { $match: { createdAt: { $gte: startOfCurrentMonth, $lt: startOfNextMonth } } },
                            { $group: { _id: null, total: { $sum: '$amount' } } },
                        ],
                        previousMonth: [
                            { $match: { createdAt: { $gte: startOfPreviousMonth, $lt: startOfCurrentMonth } } },
                            { $group: { _id: null, total: { $sum: '$amount' } } },
                        ],
                    },
                },
            ]),

            this.ticketModel.aggregate([
                { $match: comparisonTicketFilter },
                {
                    $facet: {
                        currentMonth: [
                            { $match: { createdAt: { $gte: startOfCurrentMonth, $lt: startOfNextMonth } } },
                            {
                                $group: {
                                    _id: null,
                                    ticketsSold: { $sum: 1 },
                                    checkedIn: { $sum: { $cond: [{ $eq: ['$status', 'used'] }, 1, 0] } },
                                },
                            },
                        ],
                        previousMonth: [
                            { $match: { createdAt: { $gte: startOfPreviousMonth, $lt: startOfCurrentMonth } } },
                            {
                                $group: {
                                    _id: null,
                                    ticketsSold: { $sum: 1 },
                                    checkedIn: { $sum: { $cond: [{ $eq: ['$status', 'used'] }, 1, 0] } },
                                },
                            },
                        ],
                    },
                },
            ]),
        ]);

        const totalRevenue = totalRevenueResult?.[0]?.total || 0;

        // Revenue comparison
        const currentMonthRevenue = revenueComparisonResult[0]?.currentMonth?.[0]?.total || 0;
        const previousMonthRevenue = revenueComparisonResult[0]?.previousMonth?.[0]?.total || 0;
        const revenueDifference = currentMonthRevenue - previousMonthRevenue;
        const percentageChange =
            previousMonthRevenue === 0
                ? currentMonthRevenue === 0 ? 0 : 100
                : (revenueDifference / previousMonthRevenue) * 100;

        // Tickets sold comparison
        const currentMonthTicketsSold = ticketComparisonResult[0]?.currentMonth?.[0]?.ticketsSold || 0;
        const previousMonthTicketsSold = ticketComparisonResult[0]?.previousMonth?.[0]?.ticketsSold || 0;
        const ticketsSoldDifference = currentMonthTicketsSold - previousMonthTicketsSold;
        const ticketsSoldPercentageChange =
            previousMonthTicketsSold === 0
                ? currentMonthTicketsSold === 0 ? 0 : 100
                : (ticketsSoldDifference / previousMonthTicketsSold) * 100;

        // CheckIn comparison
        const currentMonthCheckedIn = ticketComparisonResult[0]?.currentMonth?.[0]?.checkedIn || 0;
        const previousMonthCheckedIn = ticketComparisonResult[0]?.previousMonth?.[0]?.checkedIn || 0;
        const checkedInDifference = currentMonthCheckedIn - previousMonthCheckedIn;
        const checkedInPercentageChange =
            previousMonthCheckedIn === 0
                ? currentMonthCheckedIn === 0 ? 0 : 100
                : (checkedInDifference / previousMonthCheckedIn) * 100;

        return {
            totalRevenue,
            totalTicketsSold,
            totalBookings,
            totalPaidBookings,
            totalCheckedIn,
            totalRefundedAmount: 0,
            currentMonthRevenue,
            previousMonthRevenue,
            revenueDifference,
            percentageChange,
            currentMonthTicketsSold,
            previousMonthTicketsSold,
            ticketsSoldPercentageChange,
            currentMonthCheckedIn,
            previousMonthCheckedIn,
            checkedInPercentageChange,
        };
    }

    async getRevenueStatistics(
        eventId: string | undefined,
        from: string,
        to: string,
        groupBy: 'day' | 'month' = 'day',
    ) {
        const matchFilter: any = {};
        if (eventId) {
            matchFilter.eventId = new Types.ObjectId(eventId);
        }
        matchFilter.status = 'succeeded';
        matchFilter.isDeleted = false;
        matchFilter.createdAt = {
            $gte: new Date(from),
            $lte: new Date(to),
        };
        const TimeZone = '+07:00';
        const groupId: any = {};
        if (groupBy === 'day') {
            groupId.year = { $year: { date: '$createdAt', timezone: TimeZone } };
            groupId.month = { $month: { date: '$createdAt', timezone: TimeZone } };
            groupId.day = { $dayOfMonth: { date: '$createdAt', timezone: TimeZone } };
        } else if (groupBy === 'month') {
            groupId.year = { $year: { date: '$createdAt', timezone: TimeZone } };
            groupId.month = { $month: { date: '$createdAt', timezone: TimeZone } };
        }
        const revenueData = await this.paymentModel.aggregate([
            { $match: matchFilter },
            {
                $group: {
                    _id: groupId,
                    totalRevenue: { $sum: '$amount' },
                    count: { $sum: 1 }
                },
            },
            {
                $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 },
            },
        ]);
        // format data
        const formattedData = revenueData.map(item => {
            let label = '';
            if (groupBy === 'day') {
                label = `${item._id.year}-${String(item._id.month).padStart(2, '0')}-${String(item._id.day).padStart(2, '0')}`;
            } else if (groupBy === 'month') {
                label = `${item._id.year}-${String(item._id.month).padStart(2, '0')}`;
            }
            return {
                label,
                revenue: item.totalRevenue,
                count: item.count
            };
        });
        return { data: formattedData };
    }

    async getRevenueStatisticsByEvent(
        eventId: string | undefined,
    ) {
        if (!eventId) {
            throw new BadRequestException('Event ID is required');
        }
        if (!Types.ObjectId.isValid(eventId)) {
            throw new BadRequestException('Invalid event ID format');
        }
        const eventFilter = {
            eventId: new Types.ObjectId(eventId),
            status: 'succeeded',
            isDeleted: false
        };

        const [event, totalRevenueResult, ticketsSold] = await Promise.all([
            this.eventModel.findById(eventId).select('title').lean(),
            this.paymentModel.aggregate([
                { $match: eventFilter },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' },
                    },
                },
            ]),
            this.ticketModel.countDocuments({
                eventId: new Types.ObjectId(eventId),
                status: { $in: ['valid', 'used'] },
                isDeleted: false,
            }),
        ]);
        if (!event) {
            throw new NotFoundException('Event not found');
        }
        const totalRevenue = totalRevenueResult?.[0]?.total || 0;
        return {
            eventId,
            eventName: event.title || '',
            totalRevenue,
            ticketsSold,
        };
    }

    async getTopSellingEvents(
        by: 'tickets' | 'revenue' = 'tickets',
    ): Promise<RevenueStatisticsByEventResponseDto[]> {
        const data = [
            {
                $match: {
                    status: { $in: ['valid', 'used'] },
                    isDeleted: false,
                },
            },
            {
                $group: {
                    _id: '$eventId',
                    ticketsSold: { $sum: 1 },
                    totalRevenue: { $sum: '$price' },
                },
            },
            {
                $sort: (
                    by === 'tickets'
                        ? { ticketsSold: -1 }
                        : { totalRevenue: -1 }
                ) as Record<string, 1 | -1>,
            },

            { $limit: 5 },
            {
                $lookup: {
                    from: 'events',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'event',
                },
            },
            { $unwind: '$event' },
            {
                $project: {
                    _id: 0,
                    eventId: '$_id',
                    eventName: '$event.title',
                    ticketsSold: 1,
                    totalRevenue: 1,
                },
            },
        ];
        return this.ticketModel.aggregate<RevenueStatisticsByEventResponseDto>(data);
    }

    async getTopPotentialCustomers() {
        const topCustomers = await this.bookingModel.aggregate([
            {
                $match: {
                    paymentStatus: 'paid',
                    isDeleted: false,
                },
            },
            {
                $group: {
                    _id: '$userId',
                    totalBookings: { $sum: 1 },
                    totalAmountSpent: { $sum: '$totalPrice' },
                },
            },
            {
                $sort: { totalAmountSpent: -1 },
            },
            {
                $limit: 10,
            },
            {
                $lookup: {
                    from: 'users',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'userInfo',
                },
            },
            { $unwind: '$userInfo' },
            {
                $project: {
                    _id: 0,
                    userId: '$_id',
                    name: '$userInfo.name',
                    email: '$userInfo.email',
                    totalBookings: 1,
                    totalAmountSpent: 1,
                },
            },
        ]);
        return topCustomers;
    }

    async getCheckInZones(
        eventId: string,
    ) {
        if (!Types.ObjectId.isValid(eventId)) {
            throw new BadRequestException('Invalid event ID format');
        }
        return this.ticketModel.aggregate([
            {
                $match: {
                    eventId: new Types.ObjectId(eventId),
                    isDeleted: false,
                }
            },
            {
                $group: {
                    _id: '$zoneId',
                    totalTickets: { $sum: 1 }, // tổng số vé trong zone đó
                    checkedInCount: { // vé đã check-in
                        $sum: {
                            $cond: [{ $eq: ['$status', 'used'] }, 1, 0],
                            // count số vé đã check-in ( field status = 'used' : true + 1 : false + 0 )
                        },
                    },
                }
            },
            {
                $lookup: {
                    from: 'zones',
                    localField: '_id',
                    foreignField: '_id',
                    as: 'zone',
                }
            },
            { $unwind: '$zone' },
            {
                $project: {
                    _id: 0,
                    zoneId: '$_id',
                    zoneName: '$zone.name',
                    price: '$zone.price',
                    totalTickets: 1,
                    checkedInCount: 1,
                    notCheckedIn: {
                        $subtract: ['$totalTickets', '$checkedInCount'],
                    },
                    // Tỉ lệ check-in (%) = (số vé đã check-in / tổng số vé) * 100
                    checkInRate: {
                        $cond: [
                            { $eq: ['$totalTickets', 0] },
                            0,
                            {
                                $multiply: [
                                    { $divide: ['$checkedInCount', '$totalTickets'] },
                                    100,
                                ],
                            },
                        ],
                    },
                }
            },
            { $sort: { zoneName: 1 } }
        ]);
    }
}
