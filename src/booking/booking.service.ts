import { Injectable, BadRequestException, NotFoundException, Inject } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Booking } from '@src/schemas/booking.schema';
import { Event } from '@src/schemas/event.schema';
import { Zone } from '@src/schemas/zone.schema';
import { Area } from '@src/schemas/area.schema';
import { Model, Types } from 'mongoose';
import { CreateBookingDto } from './dto/create-booking.dto';
import { CACHE_MANAGER, Cache } from '@nestjs/cache-manager';
import { QueryBookingDto } from './dto/query-booking.dto';
import { PaginatedResponse } from '@src/common/interfaces/pagination-response';

@Injectable()
export class BookingService {
    private readonly BOOKINGS_CACHE_LIST_KEY = new Set<string>(); // cache list admin
    private readonly USER_BOOKINGS_CACHE_KEY = new Set<string>(); // cache list user
    constructor(
        @InjectModel(Booking.name) private bookingModel: Model<Booking>,
        @InjectModel(Event.name) private eventModel: Model<Event>,
        @InjectModel(Zone.name) private zoneModel: Model<Zone>,
        @InjectModel(Area.name) private areaModel: Model<Area>,
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
        const event = await this.eventModel.findById(data.eventId);
        if (!event) {
            throw new NotFoundException('Sự kiện không tồn tại');
        }
        const zone = await this.zoneModel.findOne({
            _id: new Types.ObjectId(data.zoneId),
            eventId: new Types.ObjectId(data.eventId),
            isDeleted: false,
        });

        if (!zone) {
            throw new NotFoundException('Khu vực không tồn tại hoặc không thuộc sự kiện này');
        }
        const availableTickets = zone.capacity - zone.soldCount;
        if (availableTickets < data.quantity) {
            throw new BadRequestException(`Chỉ còn ${availableTickets} vé trống trong khu vực này`);
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
            status: 'pending',
            paymentStatus: 'unpaid',
        };
        // Xử lý logic seating
        if (zone.hasSeating) {
            // Zone có chỗ ngồi
            if (!data.areaId) {
                throw new BadRequestException('Vui lòng chọn hàng ghế (area)');
            }
            const area = await this.areaModel.findOne({
                _id: new Types.ObjectId(data.areaId),
                zoneId: new Types.ObjectId(data.zoneId),
                isDeleted: false,
            });
            if (!area) {
                throw new NotFoundException('Hàng ghế không tồn tại');
            }
            // Xử lý seats
            if (data.seats && data.seats.length > 0) {
                // Kiểm tra số lượng seats match với quantity
                if (data.seats.length !== data.quantity) {
                    throw new BadRequestException('Số lượng ghế phải bằng số lượng vé');
                }
                // Kiểm tra seats có hợp lệ trong area
                const validSeats = area.seats || [];
                const invalidSeats = data.seats.filter(seat => !validSeats.includes(seat));

                if (invalidSeats.length > 0) {
                    throw new BadRequestException(`Các ghế không hợp lệ: ${invalidSeats.join(', ')}`);
                }
                // Kiểm tra seats đã được đặt chưa
                const existingBookings = await this.bookingModel.find({
                    eventId: new Types.ObjectId(data.eventId),
                    zoneId: new Types.ObjectId(data.zoneId),
                    areaId: new Types.ObjectId(data.areaId),
                    seats: { $in: data.seats },
                    status: { $nin: ['cancelled', 'expired'] },
                    isDeleted: false,
                });

                if (existingBookings.length > 0) {
                    const bookedSeats = existingBookings.flatMap(b => b.seats); // ==> ["A1", "A2", "B1", "C1", "C2"]
                    const conflictSeats = data.seats.filter(seat => bookedSeats.includes(seat));
                    throw new BadRequestException(`Các ghế đã được đặt: ${conflictSeats.join(', ')}`);
                }
                bookingData.seats = data.seats;
            } else {
                // Không chọn ghế cụ thể
                bookingData.seats = [];
            }
        } else {
            // Zone không có chỗ ngồi (standing zone)
            if (data.seats && data.seats.length > 0) {
                throw new BadRequestException('Không thể chọn ghế cho khu vực không có chỗ ngồi');
            }
            if (data.areaId) {
                throw new BadRequestException('Không thể chọn hàng ghế cho khu vực không có chỗ ngồi');
            }
            bookingData.seats = [];
            bookingData.areaId = undefined;
        }
        const newBooking = new this.bookingModel(bookingData);
        await newBooking.save();
        await this.invalidateBookingCache();
        await this.invalidateUserBookingCache(userId);
        // Cập nhật số lượng vé đã bán
        await this.zoneModel.findByIdAndUpdate(data.zoneId, {
            $inc: { soldCount: data.quantity }
        });
        return {
            success: true,
            message: 'Tạo booking thành công',
            data: newBooking,
        };
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
                currentPage: page,
                itemsPerPage: limit,
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
        const event = await this.eventModel.findById(eventId);
        if (!event || event.isDeleted) {
            throw new NotFoundException('Sự kiện không tồn tại');
        }

        const zone = await this.zoneModel.findOne({
            _id: new Types.ObjectId(zoneId),
            eventId: new Types.ObjectId(eventId),
            isDeleted: false,
        }).populate('eventId', 'title startDate endDate');

        if (!zone) {
            throw new NotFoundException('Khu vực không tồn tại');
        }

        let areas = [];
        let availableSeats = [];
        const availableTickets = zone.capacity - zone.soldCount;

        if (zone.hasSeating) {
            areas = await this.areaModel.find({
                zoneId: new Types.ObjectId(zoneId),
                isDeleted: false,
            }).select('name description rowLabel seatCount');

            const bookings = await this.bookingModel.find({
                eventId: new Types.ObjectId(eventId),
                zoneId: new Types.ObjectId(zoneId),
                status: { $nin: ['cancelled', 'expired'] },
                isDeleted: false,
            }).select('areaId seats');

            // TODO: Có thể tính toán seats trống chi tiết hơn
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
                areas: zone.hasSeating ? areas : null,
            },
        };
    }

    /**
     * Hủy booking
     */
    async cancelBooking(userId: string, bookingCode: string, reason?: string) {
        const booking = await this.bookingModel.findOne({
            bookingCode,
            userId: new Types.ObjectId(userId),
            status: { $in: ['pending', 'confirmed'] },
            isDeleted: false,
        });
        if (!booking) {
            throw new NotFoundException('Booking không tồn tại hoặc không thể hủy');
        }
        const wasPaid = booking.paymentStatus === 'paid';
        // Kiểm tra thời gian hủy
        const now = new Date();
        const event = await this.eventModel.findById(booking.eventId);
        if (event && event.startDate && now > event.startDate) {
            throw new BadRequestException('Không thể hủy vé sau khi sự kiện đã bắt đầu');
        }

        booking.status = 'cancelled';
        booking.cancelledAt = new Date();
        booking.cancellationReason = reason;
        booking.paymentStatus = booking.paymentStatus === 'paid' ? 'refunded' : 'unpaid';

        await booking.save();

        // Hoàn lại số lượng vé
        const updateQuery: any = {
            $inc: { soldCount: -booking.quantity }
        };
        if (wasPaid) {
            updateQuery.$inc.confirmedSoldCount = -booking.quantity;
        }

        await this.zoneModel.findByIdAndUpdate(booking.zoneId, updateQuery);
        await this.invalidateBookingCache();
        await this.invalidateUserBookingCache(userId);

        return {
            success: true,
            message: 'Hủy booking thành công',
        };
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
                { name: { $regex: search, $options: 'i' } },
                { description: { $regex: search, $options: 'i' } }
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
        const expiredBookings = await this.bookingModel.find({
            status: 'pending',
            expiresAt: { $lt: new Date() },
            isDeleted: false,
        });
        for (const booking of expiredBookings) {
            booking.status = 'expired';
            await booking.save();
            // Hoàn lại số lượng vé
            await this.zoneModel.findByIdAndUpdate(booking.zoneId, {
                $inc: { soldCount: -booking.quantity }
            });
        }
        await this.invalidateBookingCache();
        return {
            success: true,
            message: `Đã expire ${expiredBookings.length} booking`,
        };
    }
}