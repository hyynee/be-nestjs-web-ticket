import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Booking } from "@src/schemas/booking.schema";

import { Event } from "@src/schemas/event.schema";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { FilterQuery, Model, Types } from "mongoose";
import { QueryBookingDto } from "../dto/query-booking.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import {
  ZONE_INFO_STAMPEDE_LOCK_TTL_SEC,
  ZONE_INFO_STAMPEDE_MAX_POLLS,
  ZONE_INFO_STAMPEDE_POLL_DELAY_MS,
} from "../booking.constants";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { escapeRegex } from "@src/common/utils/regex.utils";
import {
  BookingDetailResult,
  BookingListItem,
  BookingListResult,
  BookingViewSource,
  ZoneBookingAreaView,
  ZoneBookingInfoResult,
} from "../domain/types/booking-response.types";
import { BookingCacheService } from "../infrastructure/cache/booking-cache.service";
import { BookingPresenter } from "../presenters/booking.presenter";
import { getErrorMessage } from "@src/helper/getErrorMessage";

const RELEASE_LOCK_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

@Injectable()
export class BookingQueryService {
  private readonly logger = new Logger(BookingQueryService.name);

  constructor(
    @InjectModel(Booking.name) private bookingModel: Model<Booking>,
    @InjectModel(Event.name) private eventModel: Model<Event>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @InjectModel(Area.name) private areaModel: Model<Area>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly bookingCacheService: BookingCacheService,
    private readonly bookingPresenter: BookingPresenter
  ) {}

  private assertObjectId(value: string, label: string): void {
    if (!Types.ObjectId.isValid(value)) {
      throw new BadRequestException(`Invalid ${label}`);
    }
  }

  async getMyBookings(
    userId: string,
    status?: string,
    page: number = 1,
    limit: number = 10
  ): Promise<BookingListResult> {
    const cacheKey = this.bookingCacheService.generateUserBookingCacheKey(
      userId,
      status,
      page,
      limit
    );
    const cached =
      await this.bookingCacheService.getJson<BookingListResult>(cacheKey);
    if (cached) return cached;
    const filter: FilterQuery<Booking> = {
      userId: new Types.ObjectId(userId),
      isDeleted: false,
    };
    if (status) {
      filter.status = status;
    }
    const skip = (page - 1) * limit;
    const [bookings, total] = await Promise.all([
      this.bookingModel
        .find(filter)
        .populate("eventId", "title startDate endDate location thumbnail")
        .populate("zoneId", "name price hasSeating")
        .populate("areaId", "name rowLabel")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean<BookingViewSource[]>(),
      this.bookingModel.countDocuments(filter),
    ]);
    const result = {
      success: true,
      items: bookings.map((booking) =>
        this.bookingPresenter.toBookingListItem(booking)
      ),
      meta: {
        currentPage: Number(page),
        itemsPerPage: Number(limit),
        totalItems: total,
        totalPages: Math.ceil(total / limit),
        hasPreviousPage: page > 1,
        hasNextPage: page < Math.ceil(total / limit),
      },
    };

    await this.bookingCacheService.setUserBookingCache(
      userId,
      cacheKey,
      result
    );

    return result;
  }

  async getBookingByCode(
    userId: string,
    bookingCode: string
  ): Promise<BookingDetailResult> {
    const query: FilterQuery<Booking> = {
      bookingCode: bookingCode.trim().toUpperCase(),
      isDeleted: false,
    };
    if (userId) {
      query.userId = new Types.ObjectId(userId);
    }

    const booking = await this.bookingModel
      .findOne(query)
      .populate("eventId", "title startDate endDate location thumbnail")
      .populate("zoneId", "name price hasSeating")
      .populate("areaId", "name rowLabel")
      .lean<BookingViewSource>();

    if (!booking) {
      throw new NotFoundException("Booking không tồn tại");
    }

    return this.bookingPresenter.bookingDetail(booking);
  }

  async getZoneBookingInfo(
    eventId: string,
    zoneId: string
  ): Promise<ZoneBookingInfoResult> {
    this.assertObjectId(eventId, "event ID");
    this.assertObjectId(zoneId, "zone ID");
    const cacheKey = this.bookingCacheService.generateZoneBookingInfoCacheKey(
      eventId,
      zoneId
    );
    const lockKey = `${cacheKey}:lock`;

    const cached =
      await this.bookingCacheService.getJson<ZoneBookingInfoResult>(cacheKey);
    if (cached) return cached;

    const lockValue = `${process.pid}-${Date.now()}`;
    const lockAcquired = await this.bookingCacheService.client
      .set(lockKey, lockValue, {
        NX: true,
        EX: ZONE_INFO_STAMPEDE_LOCK_TTL_SEC,
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `BookingQueryService: zone info lock acquire failed for eventId=${eventId}, zoneId=${zoneId}: ${getErrorMessage(error)}`
        );
        return null;
      });

    if (!lockAcquired) {
      for (let i = 0; i < ZONE_INFO_STAMPEDE_MAX_POLLS; i++) {
        await new Promise<void>((r) =>
          setTimeout(r, ZONE_INFO_STAMPEDE_POLL_DELAY_MS)
        );
        const retryResult =
          await this.bookingCacheService.getJson<ZoneBookingInfoResult>(
            cacheKey
          );
        if (retryResult) return retryResult;
      }
      this.logger.warn(
        `getZoneBookingInfo: stampede lock timed out for zone=${zoneId}, computing directly`
      );
    }

    try {
      const [event, zone] = await Promise.all([
        this.eventModel.findById(eventId),
        this.zoneModel.findOne({
          _id: new Types.ObjectId(zoneId),
          eventId: new Types.ObjectId(eventId),
          isDeleted: false,
        }),
      ]);

      if (!event || event.isDeleted) {
        throw new NotFoundException("Sự kiện không tồn tại");
      }
      if (!zone) {
        throw new NotFoundException("Khu vực không tồn tại");
      }

      const availableTickets = zone.capacity - zone.soldCount;
      let areas: ZoneBookingAreaView[] | null = null;
      let bookedSeatsByArea: Record<string, string[]> | null = null;

      if (zone.hasSeating) {
        const [fetchedAreas, bookedSeatsByAreaRaw] = await Promise.all([
          this.areaModel
            .find({ zoneId: new Types.ObjectId(zoneId), isDeleted: false })
            .select("name description rowLabel seatCount")
            .lean<ZoneBookingAreaView[]>(),
          this.bookingModel.aggregate([
            {
              $match: {
                eventId: new Types.ObjectId(eventId),
                zoneId: new Types.ObjectId(zoneId),
                isDeleted: false,
                $or: [
                  { status: "confirmed" },
                  { status: "pending", expiresAt: { $gt: new Date() } },
                ],
              },
            },
            { $unwind: "$seats" },
            {
              $group: {
                _id: "$areaId",
                seats: { $addToSet: "$seats" },
              },
            },
          ]),
        ]);

        areas = fetchedAreas;
        bookedSeatsByArea = Object.fromEntries(
          (
            bookedSeatsByAreaRaw as {
              _id: Types.ObjectId | null;
              seats: string[];
            }[]
          )
            .filter((r) => r._id != null)
            .map(({ _id, seats }) => [
              (_id as Types.ObjectId).toString(),
              seats,
            ])
        );
      }

      const result = {
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

      const ttl = 5 + Math.floor(Math.random() * 3);
      await this.bookingCacheService.setZoneBookingInfoCache(
        cacheKey,
        result,
        ttl
      );
      return result;
    } finally {
      if (lockAcquired) {
        await this.bookingCacheService.client
          .eval(RELEASE_LOCK_SCRIPT, {
            keys: [lockKey],
            arguments: [lockValue],
          })
          .catch((error: unknown) => {
            this.logger.warn(
              `BookingQueryService: zone info lock release failed for eventId=${eventId}, zoneId=${zoneId}: ${getErrorMessage(error)}`
            );
          });
      }
    }
  }

  private static readonly ALLOWED_BOOKING_SORT_FIELDS = new Set([
    "createdAt",
    "updatedAt",
    "totalPrice",
    "paidAt",
    "expiresAt",
  ]);

  async getAllBookings(
    query: QueryBookingDto,
    currentUser: JwtPayload
  ): Promise<PaginatedResponse<BookingListItem>> {
    const {
      eventId,
      search,
      status,
      paymentStatus,
      page = 1,
      limit = 20,
      sortBy = "createdAt",
      sortOrder = "desc",
    } = query;
    if (eventId && !Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!BookingQueryService.ALLOWED_BOOKING_SORT_FIELDS.has(sortBy)) {
      throw new BadRequestException(
        `Invalid sortBy field. Allowed: ${[...BookingQueryService.ALLOWED_BOOKING_SORT_FIELDS].join(", ")}`
      );
    }

    // Ownership gate MUST run before cache read/write below — otherwise an
    // organizer could get a cache hit for data they were never authorized to see.
    let scopedEventIds: Types.ObjectId[] | undefined;
    let scopeKey = "admin";

    if (currentUser.role !== "admin") {
      if (eventId) {
        await this.eventOwnershipService.assertCanManageEvent(
          currentUser,
          eventId
        );
        scopeKey = `event:${eventId}`;
      } else {
        const managedIds =
          await this.eventOwnershipService.getManagedEventIds(currentUser);
        if (managedIds.length === 0) {
          return this.bookingPresenter.bookingPage([], page, limit, 0);
        }
        scopedEventIds = managedIds;
        scopeKey = `user:${currentUser.userId}`;
      }
    } else if (eventId) {
      scopeKey = `event:${eventId}`;
    }

    const cacheKey = this.bookingCacheService.generateBookingListCacheKey(
      query,
      scopeKey
    );
    const cached =
      await this.bookingCacheService.getJson<
        PaginatedResponse<BookingListItem>
      >(cacheKey);
    if (cached) {
      return cached;
    }
    const filter: FilterQuery<Booking> = { isDeleted: false };

    if (eventId) filter.eventId = new Types.ObjectId(eventId);
    else if (scopedEventIds) filter.eventId = { $in: scopedEventIds };
    if (status) filter.status = status;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const skip = (page - 1) * limit;
    if (search) {
      const escapedSearch = escapeRegex(search.trim());

      if (escapedSearch) {
        filter.$or = [
          { bookingCode: { $regex: escapedSearch, $options: "i" } },
          { customerName: { $regex: escapedSearch, $options: "i" } },
          { customerEmail: { $regex: escapedSearch, $options: "i" } },
          { customerPhone: { $regex: escapedSearch, $options: "i" } },
          { notes: { $regex: escapedSearch, $options: "i" } },
        ];
      }
    }
    const sort: Record<string, 1 | -1> = {};
    sort[sortBy] = sortOrder === "asc" ? 1 : -1;

    const [bookings, total] = await Promise.all([
      this.bookingModel.aggregate<BookingViewSource>([
        { $match: filter },
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        {
          $lookup: {
            from: "events",
            localField: "eventId",
            foreignField: "_id",
            as: "eventId",
            pipeline: [{ $project: { title: 1, startDate: 1 } }],
          },
        },
        {
          $lookup: {
            from: "zones",
            localField: "zoneId",
            foreignField: "_id",
            as: "zoneId",
            pipeline: [{ $project: { name: 1, price: 1 } }],
          },
        },
        {
          $lookup: {
            from: "areas",
            localField: "areaId",
            foreignField: "_id",
            as: "areaId",
            pipeline: [{ $project: { name: 1, rowLabel: 1 } }],
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "userId",
            pipeline: [{ $project: { email: 1, name: 1 } }],
          },
        },
        {
          $addFields: {
            eventId: { $ifNull: [{ $arrayElemAt: ["$eventId", 0] }, null] },
            zoneId: { $ifNull: [{ $arrayElemAt: ["$zoneId", 0] }, null] },
            areaId: { $ifNull: [{ $arrayElemAt: ["$areaId", 0] }, null] },
            userId: { $ifNull: [{ $arrayElemAt: ["$userId", 0] }, null] },
          },
        },
      ]),
      this.bookingModel.countDocuments(filter),
    ]);
    const result = this.bookingPresenter.bookingPage(
      bookings,
      page,
      limit,
      total
    );
    await this.bookingCacheService.setBookingListCache(cacheKey, result);
    return result;
  }
}
