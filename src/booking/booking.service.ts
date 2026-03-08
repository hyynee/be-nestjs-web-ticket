import { Injectable, BadRequestException, NotFoundException, Inject, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Booking, BookingStatus, PaymentStatus } from '@src/schemas/booking.schema';
import { Event } from '@src/schemas/event.schema';
import { Zone } from '@src/schemas/zone.schema';
import { Area } from '@src/schemas/area.schema';
import { Model, Types } from 'mongoose';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { QueryBookingDto } from './dto/query-booking.dto';
import { PaginatedResponse } from '@src/common/interfaces/pagination-response';
import { Ticket } from '@src/schemas/ticket.schema';
import { CancleBookingDto } from './dto/cancle-booking.dto'

@Injectable()
export class BookingService {
    private readonly BOOKINGS_CACHE_LIST_KEY = new Set<string>(); // cache list admin
    private readonly USER_BOOKINGS_CACHE_KEY = new Set<string>(); // cache list user
    constructor(
        @InjectModel(Booking.name) private bookingModel: Model<Booking>,
        @InjectModel(Event.name) private eventModel: Model<Event>,
        @InjectModel(Zone.name) private zoneModel: Model<Zone>,
        @InjectModel(Area.name) private areaModel: Model<Area>,
        @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
        @Inject(CACHE_MANAGER) private cacheManager: Cache
    ) { }

    /**
     * Tạo mã booking tự động
     */
    private generateBookingCode(): string {
        const date = new Date();
        const year = date.getFullYear().toString();
        const month = (date.getMonth() + 1).toString().padStart(2, '0');
        const day = date.getDate().toString().padStart(2, '0');
        const timestamp = date.getHours().toString().padStart(2, '0') +
            date.getMinutes().toString().padStart(2, '0') +
            date.getSeconds().toString().padStart(2, '0');
        const random = Math.floor(Math.random() * 1000).toString().padStart(3, '0');

        return `BK${year}${month}${day}${timestamp}${random}`;
    }
    /* genarate cache keys */
    private generateBookingListCacheKey(query: QueryBookingDto): string {
        const { eventId, search, status, paymentStatus, page, limit, sortBy, sortOrder } = query;
        return `bookings:list:event=${eventId || 'all'}:search=${search || ''}:status=${status || 'all'}:payment=${paymentStatus || 'all'}:page=${page}:limit=${limit}:sort=${sortBy}:order=${sortOrder}`;
    }

    private async invalidateBookingCache(): Promise<void> {
        for (const key of this.BOOKINGS_CACHE_LIST_KEY) {
            await this.cacheManager.del(key);
        }
        this.BOOKINGS_CACHE_LIST_KEY.clear();
    }

    private async invalidateUserBookingCache(userId: string): Promise<void> {
        const keysToDelete: string[] = [];
        // collect keys
        for (const key of this.USER_BOOKINGS_CACHE_KEY) {
            if (key.includes(`bookings:user:${userId}:`)) {
                keysToDelete.push(key); // lọc key thuộc user này
            }
        }
        // delete safely
        for (const key of keysToDelete) {
            await this.cacheManager.del(key);
            this.USER_BOOKINGS_CACHE_KEY.delete(key); // Xóa cache thật + xóa trong Set
        }
    }

    async createBooking(userId: string, data: CreateBookingDto) {
        const session = await this.bookingModel.db.startSession();

        try {
            let result: any;
            await session.withTransaction(async () => {
                const event = await this.eventModel
                    .findById(data.eventId)
                    .session(session);
                if (!event || event.isDeleted) {
                    throw new NotFoundException('Sự kiện không tồn tại');
                }

                if (event.endDate < new Date()) {
                    throw new BadRequestException('Sự kiện đã kết thúc');
                }

                const zone = await this.zoneModel
                    .findOne({
                        _id: new Types.ObjectId(data.zoneId),
                        eventId: new Types.ObjectId(data.eventId),
                        isDeleted: false
                    })
                    .session(session);

                if (!zone) {
                    throw new NotFoundException('Khu vực không tồn tại');
                }

                const now = new Date();

                if (zone.saleStartDate && now < zone.saleStartDate) {
                    throw new BadRequestException('Chưa tới thời gian bán vé');
                }

                if (zone.saleEndDate && now > zone.saleEndDate) {
                    throw new BadRequestException('Đã hết thời gian bán vé');
                }

                let bookingData: any = {
                    ...data,
                    userId: new Types.ObjectId(userId),
                    eventId: new Types.ObjectId(data.eventId),
                    zoneId: new Types.ObjectId(data.zoneId),
                    areaId: data.areaId ? new Types.ObjectId(data.areaId) : undefined,
                    pricePerTicket: zone.price,
                    totalPrice: zone.price * data.quantity,
                    bookingCode: this.generateBookingCode(),
                    expiresAt: new Date(Date.now() + 30 * 60 * 1000),
                    status: BookingStatus.PENDING,
                    paymentStatus: PaymentStatus.UNPAID,
                };

                if (zone.hasSeating) {
                    if (!data.areaId) {
                        throw new BadRequestException('Vui lòng chọn hàng ghế (area)');
                    }
                    const area = await this.areaModel
                        .findOne({
                            _id: new Types.ObjectId(data.areaId),
                            zoneId: new Types.ObjectId(data.zoneId),
                            isDeleted: false,
                        })
                        .select('seats')
                        .session(session);
                    if (!area) {
                        throw new NotFoundException('Hàng ghế không tồn tại');
                    }

                    if (data.seats && data.seats.length > 0) {

                        if (data.seats.length !== data.quantity) {
                            throw new BadRequestException('Số lượng ghế phải bằng số lượng vé');
                        }

                        const validSeats = area.seats || [];

                        const invalidSeats = data.seats.filter(
                            seat => !validSeats.includes(seat)
                        );

                        if (invalidSeats.length > 0) {
                            throw new BadRequestException(
                                `Các ghế không hợp lệ: ${invalidSeats.join(', ')}`
                            );
                        }

                        const conflict = await this.bookingModel
                            .findOne({
                                eventId: new Types.ObjectId(data.eventId),
                                zoneId: new Types.ObjectId(data.zoneId),
                                areaId: new Types.ObjectId(data.areaId),
                                seats: { $in: data.seats },
                                status: { $nin: ['cancelled', 'expired'] },
                                isDeleted: false,
                            })
                            .session(session)
                            .select('_id');

                        if (conflict) {
                            throw new BadRequestException(
                                'Một số ghế đã được đặt, vui lòng chọn lại'
                            );
                        }

                        bookingData.seats = data.seats;

                    } else {
                        bookingData.seats = [];
                    }

                } else {

                    if (data.seats && data.seats.length > 0) {
                        throw new BadRequestException(
                            'Không thể chọn ghế cho khu vực không có chỗ ngồi'
                        );
                    }

                    if (data.areaId) {
                        throw new BadRequestException(
                            'Không thể chọn hàng ghế cho khu vực không có chỗ ngồi'
                        );
                    }

                    bookingData.seats = [];
                    bookingData.areaId = undefined;
                }

                const zoneUpdate = await this.zoneModel.findOneAndUpdate(
                    {
                        _id: new Types.ObjectId(data.zoneId),
                        eventId: new Types.ObjectId(data.eventId),
                        isDeleted: false,
                        $expr: {
                            $gte: [
                                { $subtract: ['$capacity', '$soldCount'] },
                                data.quantity
                            ]
                        }
                    },
                    { $inc: { soldCount: data.quantity } },
                    { session, new: true }
                );

                if (!zoneUpdate) {
                    throw new BadRequestException('Không đủ vé');
                }

                const newBooking = new this.bookingModel(bookingData);

                await newBooking.save({ session });

                result = {
                    success: true,
                    message: 'Tạo booking thành công',
                    data: newBooking,
                };

            });

            await Promise.all([
                this.invalidateBookingCache(),
                this.invalidateUserBookingCache(userId),
            ]);

            return result;

        } catch (error) {
            throw error;
        } finally {
            session.endSession();
        }
    }

    async getMyBookings(userId: string, status?: string, page: number = 1, limit: number = 10) {
        const cacheKey = `bookings:user:${userId}:status=${status || 'all'}:page=${page}:limit=${limit}`;
        const cachedData = await this.cacheManager.get<PaginatedResponse<Booking>>(cacheKey);
        if (cachedData) {
            return cachedData;
        };
        const filter: any = {
            userId: new Types.ObjectId(userId),
            isDeleted: false
        };
        if (status) {
            filter.status = status;
        }
        const skip = (page - 1) * limit;
        const [bookings, total] = await Promise.all([
            this.bookingModel.find(filter)
                .populate('eventId', 'title startDate endDate location thumbnail')
                .populate('zoneId', 'name price hasSeating')
                .populate('areaId', 'name rowLabel')
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit),
            this.bookingModel.countDocuments(filter)
        ]);
        const result = {
            success: true,
            items: bookings,
            meta: {
                currentPage: Number(page),
                itemsPerPage: Number(limit),
                totalItems: total,
                totalPages: Math.ceil(total / limit),
                hasPreviousPage: page > 1,
                hasNextPage: page < Math.ceil(total / limit),
            }
        };

        await this.cacheManager.set(cacheKey, result, 30);
        this.USER_BOOKINGS_CACHE_KEY.add(cacheKey);

        return result;
    }
    async getBookingByCode(userId: string, bookingCode: string) {
        const query: any = {
            bookingCode,
            isDeleted: false
        };
        if (userId) {
            query.userId = new Types.ObjectId(userId);
        }

        const booking = await this.bookingModel.findOne(query)
            .populate('eventId', 'title startDate endDate location thumbnail')
            .populate('zoneId', 'name price hasSeating')
            .populate('areaId', 'name rowLabel');

        if (!booking) {
            throw new NotFoundException('Booking không tồn tại');
        }

        return {
            success: true,
            data: booking,
        };
    }

    /**
     * Lấy thông tin zone để hiển thị cho user chọn
     */
    async getZoneBookingInfo(eventId: string, zoneId: string) {
    const [event, zone] = await Promise.all([
        this.eventModel.findById(eventId),
        this.zoneModel.findOne({
            _id: new Types.ObjectId(zoneId),
            eventId: new Types.ObjectId(eventId),
            isDeleted: false,
        }),
    ]);

    if (!event || event.isDeleted) {
        throw new NotFoundException('Sự kiện không tồn tại');
    }
    if (!zone) {
        throw new NotFoundException('Khu vực không tồn tại');
    }

    const availableTickets = zone.capacity - zone.soldCount;
    let areas: Awaited<ReturnType<typeof this.areaModel.find>> | null = null;
    let bookedSeatsByArea: Record<string, string[]> | null = null;

    if (zone.hasSeating) {
        const [fetchedAreas, bookings] = await Promise.all([
            this.areaModel
                .find({ zoneId: new Types.ObjectId(zoneId), isDeleted: false })
                .select('name description rowLabel seatCount')
                .lean(),
            this.bookingModel
                .find({
                    eventId: new Types.ObjectId(eventId),
                    zoneId: new Types.ObjectId(zoneId),
                    status: { $nin: ['cancelled', 'expired'] },
                    isDeleted: false,
                })
                .select('areaId seats')
                .lean(),
        ]);

        areas = fetchedAreas;
        bookedSeatsByArea = {};

        for (const booking of bookings) {
            if (!booking.areaId || !booking.seats?.length) continue;
            const areaKey = booking.areaId.toString();
            if (!bookedSeatsByArea[areaKey]) {
                bookedSeatsByArea[areaKey] = [];
            }
            bookedSeatsByArea[areaKey].push(...booking.seats);
        }

        for (const key of Object.keys(bookedSeatsByArea)) {
            bookedSeatsByArea[key] = [...new Set(bookedSeatsByArea[key])];
        }
    }

    return {
        success: true,
        data: {
            event: {
                _id: event._id,
                title: event.title,
                startDate: event.startDate,
                endDate: event.endDate,
                location: event.location,
            },
            zone: {
                _id: zone._id,
                name: zone.name,
                price: zone.price,
                hasSeating: zone.hasSeating,
                capacity: zone.capacity,
                soldCount: zone.soldCount,
                availableTickets,
                saleStartDate: zone.saleStartDate,
                saleEndDate: zone.saleEndDate,
            },
            areas,               
            bookedSeatsByArea,   
        },
    };
    }

    /**
     * Hủy booking
     */
    async cancelBooking(userId: string, dto: CancleBookingDto) {
        const session = await this.bookingModel.db.startSession();
        const { bookingCode } = dto;
        try {
            await session.withTransaction(async () => {
                const booking = await this.bookingModel.findOne({
                    bookingCode: bookingCode.trim().toUpperCase(),
                    isDeleted: false,
                }).session(session);

                if (!booking) throw new NotFoundException("Booking not found");

                if (booking.userId.toString() !== userId)
                    throw new ForbiddenException();

                if (![BookingStatus.PENDING, BookingStatus.CONFIRMED].includes(booking.status)) {
                    throw new BadRequestException(
                        `Cannot cancel booking with status ${booking.status}`
                    );
                }

                const oldStatus = booking.status;
                booking.status = BookingStatus.CANCELLED;
                booking.cancelledAt = new Date();
                booking.cancelledBy = new Types.ObjectId(userId);
                await booking.save({ session });

                await this.ticketModel.updateMany(
                    {
                        bookingId: booking._id,
                        status: "valid",
                    },
                    {
                        $set: {
                            status: "cancelled",
                            cancelledAt: new Date(),
                            cancelledBy: new Types.ObjectId(userId),
                        },
                    },
                    { session }
                );
                if ([BookingStatus.PENDING, BookingStatus.CONFIRMED].includes(oldStatus)) {
                    await this.zoneModel.findByIdAndUpdate(
                        booking.zoneId,
                        {
                            $inc: {
                                soldCount: -booking.quantity,
                                ...(oldStatus === BookingStatus.CONFIRMED && {
                                    confirmedSoldCount: -booking.quantity
                                }),
                            }
                        },
                        { session }
                    );
                }
            });
            await Promise.all([
                this.invalidateBookingCache(),
                this.invalidateUserBookingCache(userId),
            ]);

            return { message: "Booking cancelled successfully" };
        } catch (error) {
            console.error("CANCEL BOOKING ERROR:", error);
            throw error;
        }
        finally {
            session.endSession();
        }
    }

    /* Admin */
    async getAllBookings(query: QueryBookingDto): Promise<PaginatedResponse<Booking>> {
        const { eventId, search, status, paymentStatus, page = 1, limit = 20, sortBy = 'createdAt', sortOrder = 'desc' } = query;
        if (eventId && !Types.ObjectId.isValid(eventId)) {
            throw new BadRequestException("Invalid event ID");
        }
        const cacheKey = this.generateBookingListCacheKey(query);
        const cachedData = await this.cacheManager.get<PaginatedResponse<Booking>>(cacheKey);
        if (cachedData) {
            return cachedData;
        }
        const filter: any = { isDeleted: false };

        if (eventId) filter.eventId = new Types.ObjectId(eventId);
        if (status) filter.status = status;
        if (paymentStatus) filter.paymentStatus = paymentStatus;

        const skip = (page - 1) * limit;
        if (search) {
            filter.$or = [
                { bookingCode: { $regex: search, $options: 'i' } },
                { customerName: { $regex: search, $options: 'i' } },
                { customerEmail: { $regex: search, $options: 'i' } },
                { customerPhone: { $regex: search, $options: 'i' } },
                { notes: { $regex: search, $options: 'i' } },
            ];
        }
        const sort: any = {};
        sort[sortBy] = sortOrder === 'asc' ? 1 : -1;

        const [bookings, total] = await Promise.all([
            this.bookingModel.find(filter)
                .populate('eventId', 'title startDate')
                .populate('zoneId', 'name price')
                .populate('userId', 'email name')
                .sort(sort)
                .skip(skip)
                .limit(limit),
            this.bookingModel.countDocuments(filter)
        ]);
        const totalPages = Math.ceil(total / limit);
        const result: PaginatedResponse<Booking> = {
            items: bookings,
            meta: {
                currentPage: page,
                itemsPerPage: limit,
                totalItems: total,
                totalPages,
                hasPreviousPage: page > 1,
                hasNextPage: page < totalPages,
            }
        };
        await this.cacheManager.set(cacheKey, result, 30000);
        this.BOOKINGS_CACHE_LIST_KEY.add(cacheKey);
        return result;
    }

    async expirePendingBookings() {
        const session = await this.bookingModel.db.startSession();
        try {
            return await session.withTransaction(async () => {
                const expiredBookings = await this.bookingModel
                    .find({
                        status: BookingStatus.PENDING,
                        expiresAt: { $lt: new Date() },
                        isDeleted: false,
                    })
                    .select('_id zoneId quantity')
                    .session(session)
                    .lean();

                if (!expiredBookings.length) {
                    return { success: true, message: 'Không có booking hết hạn' };
                }

                await this.bookingModel.updateMany(
                    { _id: { $in: expiredBookings.map(b => b._id) } },
                    { $set: { status: BookingStatus.EXPIRED } },
                    { session }
                );

                const zoneMap = new Map<string, number>();
                for (const b of expiredBookings) {
                    const key = b.zoneId.toString();
                    zoneMap.set(key, (zoneMap.get(key) || 0) + b.quantity);
                }

                await this.zoneModel.bulkWrite( // PMbulkWrite cho phép gửi nhiều write operations trong 1 request đến MongoDB thay vì gửi từng cái một (nếu có 100 booking expired thuộc 10 zone khác nhau thì thay vì 10 round-trips, chỉ cần 1)
                    [...zoneMap.entries()].map(([zoneId, quantity]) => ({
                        updateOne: {
                            filter: { _id: new Types.ObjectId(zoneId) },
                            update: { $inc: { soldCount: -quantity } },
                        }
                    })),
                    { session }
                );

                return {
                    success: true,
                    message: `Đã expire ${expiredBookings.length} booking`,
                };
            });
        } finally {
            session.endSession();
            await this.invalidateBookingCache();
        }
    }

    async cleanupOldBookings(before: Date) {
        await this.bookingModel.deleteMany({
            status: { $in: ['expired', 'cancelled'] },
            updatedAt: { $lt: before },
            isDeleted: false,
        });
    }
}