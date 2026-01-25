import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { DashboardOverviewDto } from './dto/dashboard.dto';
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

    async getOverviewStatistics(
        eventId?: string,
        startDate?: string,
        endDate?: string,
    ): Promise<DashboardOverviewDto> {

        const bookingFilter: any = {};
        const paymentFilter: any = {};
        const ticketFilter: any = { isDeleted: false };
        if (eventId) {
            bookingFilter.eventId = eventId;
            paymentFilter.eventId = eventId;
            ticketFilter.eventId = eventId;
        }
        if (startDate && endDate) {
            const start = new Date(startDate);
            const end = new Date(endDate);
            bookingFilter.createdAt = { $gte: start, $lte: end };
            paymentFilter.createdAt = { $gte: start, $lte: end };
            ticketFilter.createdAt = { $gte: start, $lte: end };
        }

        const [totalRevenueResult, totalTicketsSoldResult, totalBookings, totalPaidBookingsResult, totalCheckedInResult] = await Promise.all([
            // Tổng doanh thu (payment = succeeded)
            this.paymentModel.aggregate([
                {
                    $match: {
                        ...paymentFilter,
                        status: 'succeeded',
                        isDeleted: false,
                    },
                },
                {
                    $group: {
                        _id: null,
                        total: { $sum: '$amount' },
                    },
                },
            ]),
            // Tổng vé đã bán (booking đã thanh toán)
            this.ticketModel.countDocuments({
                ...ticketFilter,
                status: { $in: ['valid', 'used'] },
            }),
            // Tổng booking đã tạo
            this.bookingModel.countDocuments(bookingFilter),
            //  Tổng booking đã thanh toán
            this.bookingModel.countDocuments({
                ...bookingFilter,
                paymentStatus: 'paid',
            }),
            // Tổng booking đã check-in
            this.ticketModel.countDocuments({
                ...ticketFilter,
                status: 'used',
            })

        ]);
        const totalRevenue = totalRevenueResult?.[0]?.total || 0;
        const totalTicketsSold = totalTicketsSoldResult || 0;
        const totalPaidBookings = totalPaidBookingsResult || 0;
        const totalCheckedIn = totalCheckedInResult || 0;
        return { totalRevenue, totalTicketsSold, totalBookings, totalPaidBookings, totalCheckedIn, totalRefundedAmount: 0 }
    }

    async getRevenueStatistics(
        eventId: string | undefined,
        from: string,
        to: string,
        groupBy: 'day' | 'month' = 'day',
    ) {
        const matchFilter: any = {};
        if (eventId) {
            matchFilter.eventId = eventId;
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
            eventId,
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
                eventId,
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
}
