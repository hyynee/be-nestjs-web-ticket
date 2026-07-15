import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Inject,
  Logger,
} from "@nestjs/common";
import { FilterQuery, Model, Types } from "mongoose";
import { InjectModel } from "@nestjs/mongoose";
import { Event, EventStatus } from "@src/schemas/event.schema";
import { CreateEventDTO } from "./dto/create-event.dto";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { UpdateEventDTO } from "./dto/update-event.dto";
import { QueryEventDTO } from "./dto/query-event.dto";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Booking, BookingStatus } from "@src/schemas/booking.schema";
import { User } from "@src/schemas/user.schema";
import { CACHE_MANAGER, Cache } from "@nestjs/cache-manager";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { BookingService } from "@src/booking/booking.service";
import { RedisService } from "@src/redis/redis.service";
import { EventOwnershipService } from "./event-ownership.service";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";

const CANCEL_BATCH_SIZE = 50;

@Injectable()
export class EventService {
  private readonly logger = new Logger(EventService.name);

  constructor(
    @InjectModel(Event.name) private readonly eventModel: Model<Event>,
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly bookingService: BookingService,
    private readonly redisService: RedisService,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly auditService: AuditService
  ) {}

  // Example: cache event list
  async getCachedEvents(query: QueryEventDTO) {
    // Sort keys alphabetically before stringifying — JSON.stringify property order varies
    // by insertion order so the same query with different parameter order would miss cache.
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      status,
    } = query;
    const normalized = Object.fromEntries(
      Object.entries({ page, limit, search, sortBy, sortOrder, status })
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
    );
    const cacheKey = `event:list:${Buffer.from(JSON.stringify(normalized)).toString("base64")}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;
    const events = await this.getEvents(query);
    await this.cacheManager.set(cacheKey, events, 30_000);
    // Track list cache key for later invalidation
    await this.redisService.client
      .sAdd("events:list:index", cacheKey)
      .catch(() => {});
    await this.redisService.client
      .expire("events:list:index", 60)
      .catch(() => {});
    return events;
  }

  // Example: cache event by id
  async getEventById(eventId: string) {
    const cacheKey = `event:details:${eventId}`;
    const cached = await this.cacheManager.get<any>(cacheKey);
    if (cached) return cached;
    const event = await this.eventModel.findById(eventId);
    if (!event) throw new NotFoundException("Event not found");
    await this.cacheManager.set(cacheKey, event, 60_000);
    return event;
  }

  async getEvents(query: QueryEventDTO, user?: JwtPayload) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      status,
    } = query;

    const skip = (page - 1) * limit;
    const isAdmin = user?.role === "admin";

    const filter: any = {};

    if (!isAdmin) {
      filter.isDeleted = false;
    } else {
      if (query.isDeleted !== undefined) {
        filter.isDeleted = query.isDeleted;
      }
    }

    if (search?.trim()) {
      const escaped = escapeRegex(search.trim());
      filter.$or = [
        { title: { $regex: escaped, $options: "i" } },
        { description: { $regex: escaped, $options: "i" } },
        { location: { $regex: escaped, $options: "i" } },
      ];
    }

    if (status) {
      filter.status = status;
    }

    const sort: Record<string, 1 | -1> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const [events, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .populate("createdBy", "email fullName")
        .exec(),
      this.eventModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items: events,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  async getEventZones(eventId: string, user?: JwtPayload) {
    const isAdmin = user?.role === "admin";

    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const event = await this.eventModel.findOne({
      _id: new Types.ObjectId(eventId),
      ...(isAdmin ? {} : { isDeleted: false }),
    });

    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    const pipeline: any[] = [
      {
        $match: {
          eventId: event._id,
          ...(isAdmin ? {} : { isDeleted: false }),
        },
      },
      {
        $lookup: {
          from: "areas",
          localField: "_id",
          foreignField: "zoneId",
          as: "areas",
          pipeline: [
            { $match: { ...(isAdmin ? {} : { isDeleted: false }) } },
            { $sort: { createdAt: 1 } },
            ...(isAdmin
              ? []
              : [
                  {
                    $project: {
                      name: 1,
                    },
                  },
                ]),
          ],
        },
      },
      {
        $addFields: {
          hasAreas: { $gt: [{ $size: "$areas" }, 0] },
        },
      },
      { $sort: { createdAt: 1 } },
    ];

    if (!isAdmin) {
      pipeline.push({
        $project: {
          name: 1,
          price: 1,
          hasSeating: 1,
          hasAreas: 1,
          areas: 1,
        },
      });
    }

    return this.zoneModel.aggregate(pipeline);
  }

  async getActiveEventById(id: string): Promise<Event> {
    const event = await this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .populate("createdBy", "email fullName role")
      .exec();
    if (!event) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }
    return event;
  }

  async getDeletedEvents(): Promise<Event[]> {
    return this.eventModel.find({ isDeleted: true }).exec();
  }

  /** Events the current user owns (`createdBy`) or is assigned to as organizer. Admins get the same result as `getEvents`. */
  async getMyManagedEvents(currentUser: JwtPayload, query: QueryEventDTO) {
    const {
      page = 1,
      limit = 10,
      search,
      sortBy = "createdAt",
      sortOrder = "desc",
      status,
    } = query;

    const skip = (page - 1) * limit;
    const userObjectId = new Types.ObjectId(currentUser.userId);

    const filter: FilterQuery<Event> = { isDeleted: false };
    const andConditions: FilterQuery<Event>[] = [
      { $or: [{ createdBy: userObjectId }, { organizerIds: userObjectId }] },
    ];

    if (search?.trim()) {
      const escaped = escapeRegex(search.trim());
      andConditions.push({
        $or: [
          { title: { $regex: escaped, $options: "i" } },
          { description: { $regex: escaped, $options: "i" } },
          { location: { $regex: escaped, $options: "i" } },
        ],
      });
    }

    if (status) {
      filter.status = status;
    }
    filter.$and = andConditions;

    const sort: Record<string, 1 | -1> = {
      [sortBy]: sortOrder === "asc" ? 1 : -1,
    };

    const [events, total] = await Promise.all([
      this.eventModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limit)
        .lean()
        .populate("createdBy", "email fullName")
        .exec(),
      this.eventModel.countDocuments(filter),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items: events,
      meta: {
        currentPage: page,
        itemsPerPage: limit,
        totalItems: total,
        totalPages,
        hasPreviousPage: page > 1,
        hasNextPage: page < totalPages,
      },
    };
  }

  /** Grants organizer-level management of `eventId` to `targetUserId`. Promotes a plain `user` role to `organizer` so RolesGuard actually lets them in. */
  async addOrganizerToEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException("Invalid user ID");
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const session = await this.eventModel.db.startSession();
    let updatedEvent!: Event;
    let promotedRole = false;

    try {
      await session.withTransaction(async () => {
        const event = await this.eventModel
          .findOne({ _id: eventId, isDeleted: false })
          .session(session);
        if (!event) {
          throw new NotFoundException(`Event with ID ${eventId} not found`);
        }

        const isAlreadyManager =
          event.createdBy.toString() === targetUserId ||
          event.organizerIds.some((id) => id.toString() === targetUserId);
        if (isAlreadyManager) {
          throw new BadRequestException(
            "User already manages this event as owner or organizer"
          );
        }

        const targetUser = await this.userModel
          .findById(targetUserId)
          .select("_id role isActive")
          .lean()
          .session(session);
        if (!targetUser) {
          throw new NotFoundException("User not found");
        }
        if (targetUser.isActive === false) {
          throw new BadRequestException(
            "Cannot assign an inactive user as organizer"
          );
        }

        event.organizerIds.push(new Types.ObjectId(targetUserId));
        await event.save({ session });

        if (targetUser.role !== "admin" && targetUser.role !== "organizer") {
          await this.userModel.updateOne(
            { _id: targetUserId },
            { $set: { role: "organizer" } },
            { session }
          );
          promotedRole = true;
        }

        updatedEvent = event;
      });
    } finally {
      await session.endSession();
    }

    if (promotedRole) {
      await this.redisService.client
        .del(`auth:user-state:${targetUserId}`)
        .catch(() => {});
    }

    await this.invalidateEventCache(eventId);

    await this.auditService.record({
      action: AuditAction.EVENT_ORGANIZER_ADD,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      metadata: { targetUserId },
    });

    return updatedEvent;
  }

  /** Revokes organizer access to `eventId` from `targetUserId`. The original creator can never be removed through this API. */
  async removeOrganizerFromEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException("Invalid user ID");
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel.findOne({
      _id: eventId,
      isDeleted: false,
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    if (event.createdBy.toString() === targetUserId) {
      throw new BadRequestException(
        "Cannot remove the event owner — transfer ownership is not supported"
      );
    }

    const wasOrganizer = event.organizerIds.some(
      (id) => id.toString() === targetUserId
    );
    if (!wasOrganizer) {
      throw new BadRequestException("User is not an organizer of this event");
    }

    event.organizerIds = event.organizerIds.filter(
      (id) => id.toString() !== targetUserId
    );
    await event.save();
    await this.invalidateEventCache(eventId);

    await this.auditService.record({
      action: AuditAction.EVENT_ORGANIZER_REMOVE,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      metadata: { targetUserId },
    });

    return event;
  }

  /** List of check-in staff assigned to `eventId`, with minimal profile fields. Manager-only (owner/organizer/admin). */
  async getEventStaff(
    currentUser: JwtPayload,
    eventId: string
  ): Promise<
    Array<{ _id: Types.ObjectId; email?: string; fullName?: string }>
  > {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel
      .findOne({ _id: eventId, isDeleted: false })
      .select("staffIds")
      .populate("staffIds", "email fullName")
      .lean<{
        staffIds: Array<{
          _id: Types.ObjectId;
          email?: string;
          fullName?: string;
        }>;
      }>();

    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    return event.staffIds ?? [];
  }

  /** Grants check-in-only access to `eventId` for `targetUserId`. Promotes a plain `user` role to `checkin_staff` so RolesGuard actually lets them in. */
  async addStaffToEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string,
    notes?: string
  ): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException("Invalid user ID");
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const session = await this.eventModel.db.startSession();
    let updatedEvent!: Event;
    let promotedRole = false;

    try {
      await session.withTransaction(async () => {
        const event = await this.eventModel
          .findOne({ _id: eventId, isDeleted: false })
          .session(session);
        if (!event) {
          throw new NotFoundException(`Event with ID ${eventId} not found`);
        }

        const isAlreadyStaff = event.staffIds.some(
          (id) => id.toString() === targetUserId
        );
        if (isAlreadyStaff) {
          throw new BadRequestException(
            "User is already check-in staff for this event"
          );
        }

        const targetUser = await this.userModel
          .findById(targetUserId)
          .select("_id role isActive")
          .lean()
          .session(session);
        if (!targetUser) {
          throw new NotFoundException("User not found");
        }
        if (targetUser.isActive === false) {
          throw new BadRequestException(
            "Cannot assign an inactive user as check-in staff"
          );
        }

        event.staffIds.push(new Types.ObjectId(targetUserId));
        await event.save({ session });

        if (targetUser.role === "user") {
          await this.userModel.updateOne(
            { _id: targetUserId },
            { $set: { role: "checkin_staff" } },
            { session }
          );
          promotedRole = true;
        }

        updatedEvent = event;
      });
    } finally {
      await session.endSession();
    }

    if (promotedRole) {
      await this.redisService.client
        .del(`auth:user-state:${targetUserId}`)
        .catch(() => {});
    }

    await this.invalidateEventCache(eventId);

    await this.auditService.record({
      action: AuditAction.EVENT_STAFF_ADD,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      reason: notes,
      metadata: { targetUserId },
    });

    return updatedEvent;
  }

  /** Revokes check-in access to `eventId` from `targetUserId`. */
  async removeStaffFromEvent(
    currentUser: JwtPayload,
    eventId: string,
    targetUserId: string
  ): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    if (!Types.ObjectId.isValid(targetUserId)) {
      throw new BadRequestException("Invalid user ID");
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel.findOne({
      _id: eventId,
      isDeleted: false,
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }

    const wasStaff = event.staffIds.some(
      (id) => id.toString() === targetUserId
    );
    if (!wasStaff) {
      throw new BadRequestException(
        "User is not check-in staff for this event"
      );
    }

    event.staffIds = event.staffIds.filter(
      (id) => id.toString() !== targetUserId
    );
    await event.save();
    await this.invalidateEventCache(eventId);

    await this.auditService.record({
      action: AuditAction.EVENT_STAFF_REMOVE,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
      metadata: { targetUserId },
    });

    return event;
  }

  private async invalidateEventCache(eventId: string): Promise<void> {
    try {
      await this.cacheManager.del(`event:details:${eventId}`);

      const listKeys =
        await this.redisService.client.sMembers("events:list:index");
      if (listKeys.length > 0) {
        await Promise.all(listKeys.map((k) => this.cacheManager.del(k)));
        await this.redisService.client.del("events:list:index");
      }
    } catch {
      /* Non-fatal */
    }
  }

  private validateTimeSlots(
    timeSlots: CreateEventDTO["timeSlots"],
    startDate: Date,
    endDate: Date
  ): void {
    if (!timeSlots || timeSlots.length === 0) return;
    for (const slot of timeSlots) {
      if (slot.startTime >= slot.endTime) {
        throw new BadRequestException(
          `Slot "${slot.label}": startTime phải trước endTime`
        );
      }
      if (slot.startTime < startDate) {
        throw new BadRequestException(
          `Slot "${slot.label}": startTime không được trước startDate của sự kiện`
        );
      }
      if (slot.endTime > endDate) {
        throw new BadRequestException(
          `Slot "${slot.label}": endTime không được sau endDate của sự kiện`
        );
      }
    }
  }

  /** Synchronous field-level checks shared by publish() and updateEvent() when it targets "active". */
  private assertEventFieldsPublishable(
    title: string,
    location: string,
    startDate: Date,
    endDate: Date
  ): void {
    if (!title || !title.trim()) {
      throw new BadRequestException("Event thiếu tiêu đề, không thể publish");
    }
    if (!location || !location.trim()) {
      throw new BadRequestException("Event thiếu địa điểm, không thể publish");
    }
    if (!(new Date(startDate) < new Date(endDate))) {
      throw new BadRequestException(
        "Ngày bắt đầu phải trước ngày kết thúc để publish"
      );
    }
  }

  /** Zone/area inventory checks shared by publish() and updateEvent() when it targets "active". */
  private async assertInventoryPublishable(
    eventId: Types.ObjectId,
    eventEndDate: Date
  ): Promise<void> {
    const zones = await this.zoneModel
      .find({ eventId, isDeleted: false })
      .lean();

    if (zones.length === 0) {
      throw new BadRequestException(
        "Event chưa có zone nào đang hoạt động, không thể publish"
      );
    }

    const totalCapacity = zones.reduce(
      (sum, zone) => sum + (zone.capacity ?? 0),
      0
    );
    if (totalCapacity <= 0) {
      throw new BadRequestException(
        "Tổng capacity của các zone phải lớn hơn 0 để publish"
      );
    }

    for (const zone of zones) {
      if (typeof zone.price !== "number" || zone.price < 0) {
        throw new BadRequestException(
          `Zone "${zone.name}" có giá vé không hợp lệ`
        );
      }
      if (
        zone.saleStartDate &&
        zone.saleEndDate &&
        zone.saleStartDate > zone.saleEndDate
      ) {
        throw new BadRequestException(
          `Zone "${zone.name}" có thời gian mở bán không hợp lệ (bắt đầu sau kết thúc)`
        );
      }
      if (zone.saleEndDate && zone.saleEndDate > new Date(eventEndDate)) {
        throw new BadRequestException(
          `Zone "${zone.name}" có ngày kết thúc mở bán sau ngày kết thúc sự kiện`
        );
      }
    }

    const seatingZoneIds = zones
      .filter((zone) => zone.hasSeating)
      .map((zone) => zone._id);

    if (seatingZoneIds.length === 0) {
      return;
    }

    const areas = await this.areaModel
      .find({ zoneId: { $in: seatingZoneIds }, isDeleted: false })
      .lean();

    const areasByZoneId = new Map<string, typeof areas>();
    for (const area of areas) {
      const key = area.zoneId.toString();
      const bucket = areasByZoneId.get(key);
      if (bucket) {
        bucket.push(area);
      } else {
        areasByZoneId.set(key, [area]);
      }
    }

    for (const zone of zones) {
      if (!zone.hasSeating) continue;
      const zoneAreas = areasByZoneId.get(zone._id.toString()) ?? [];
      if (zoneAreas.length === 0) {
        throw new BadRequestException(
          `Zone "${zone.name}" bật bán theo ghế nhưng chưa có khu vực (area) nào`
        );
      }
      for (const area of zoneAreas) {
        if (!area.seats || area.seats.length === 0) {
          throw new BadRequestException(
            `Khu vực "${area.name}" (zone "${zone.name}") chưa có ghế nào`
          );
        }
        if (new Set(area.seats).size !== area.seats.length) {
          throw new BadRequestException(
            `Khu vực "${area.name}" (zone "${zone.name}") có ghế bị trùng lặp`
          );
        }
      }
    }
  }

  /** Publishes a draft/inactive event to "active" after validating inventory is bookable. */
  async publishEvent(currentUser: JwtPayload, eventId: string): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const event = await this.eventModel.findOne({
      _id: eventId,
      isDeleted: false,
    });
    if (!event) {
      throw new NotFoundException(`Event with ID ${eventId} not found`);
    }
    if (
      event.status !== EventStatus.DRAFT &&
      event.status !== EventStatus.INACTIVE
    ) {
      throw new BadRequestException(
        `Không thể publish event đang ở trạng thái "${event.status}"`
      );
    }

    this.assertEventFieldsPublishable(
      event.title,
      event.location,
      event.startDate,
      event.endDate
    );
    await this.assertInventoryPublishable(event._id, event.endDate);

    const updated = await this.eventModel.findOneAndUpdate(
      { _id: event._id, isDeleted: false, status: event.status },
      {
        $set: {
          status: EventStatus.ACTIVE,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );
    if (!updated) {
      throw new BadRequestException(
        "Trạng thái event đã thay đổi, vui lòng thử lại"
      );
    }

    await this.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_PUBLISH,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
    });

    return updated;
  }

  /** Pauses booking on an active event without ending its lifecycle. */
  async unpublishEvent(
    currentUser: JwtPayload,
    eventId: string
  ): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const updated = await this.eventModel.findOneAndUpdate(
      { _id: eventId, isDeleted: false, status: EventStatus.ACTIVE },
      {
        $set: {
          status: EventStatus.INACTIVE,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );
    if (!updated) {
      const exists = await this.eventModel.exists({
        _id: eventId,
        isDeleted: false,
      });
      if (!exists) {
        throw new NotFoundException(`Event with ID ${eventId} not found`);
      }
      throw new BadRequestException(
        "Chỉ có thể unpublish event đang ở trạng thái active"
      );
    }

    await this.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_UNPUBLISH,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
    });

    return updated;
  }

  /** Manually ends an active/inactive event's lifecycle (terminal state, same as auto-end). */
  async endEvent(currentUser: JwtPayload, eventId: string): Promise<Event> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    await this.eventOwnershipService.assertCanManageEvent(currentUser, eventId);

    const updated = await this.eventModel.findOneAndUpdate(
      {
        _id: eventId,
        isDeleted: false,
        status: { $in: [EventStatus.ACTIVE, EventStatus.INACTIVE] },
      },
      {
        $set: {
          status: EventStatus.ENDED,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );
    if (!updated) {
      const exists = await this.eventModel.exists({
        _id: eventId,
        isDeleted: false,
      });
      if (!exists) {
        throw new NotFoundException(`Event with ID ${eventId} not found`);
      }
      throw new BadRequestException(
        "Chỉ có thể kết thúc event đang active hoặc inactive"
      );
    }

    await this.invalidateEventCache(eventId);
    await this.auditService.record({
      action: AuditAction.EVENT_END,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId,
    });

    return updated;
  }

  async createEvent(
    currentUser: JwtPayload,
    eventData: CreateEventDTO
  ): Promise<Event> {
    this.validateTimeSlots(
      eventData.timeSlots,
      eventData.startDate,
      eventData.endDate
    );
    const newEvent = new this.eventModel({
      createdBy: new Types.ObjectId(currentUser.userId),
      ...eventData,
    });
    if (eventData.status === EventStatus.ACTIVE) {
      // A brand-new event can never have zones yet, so this will always
      // reject — by design: creation can't be used to skip the publish
      // validation. Kept explicit rather than silently downgrading to draft.
      this.assertEventFieldsPublishable(
        eventData.title,
        eventData.location,
        eventData.startDate,
        eventData.endDate
      );
      await this.assertInventoryPublishable(newEvent._id, eventData.endDate);
    }
    const saved = await newEvent.save();
    await this.invalidateEventCache(saved._id.toString());
    return saved;
  }

  async updateEvent(
    currentUser: JwtPayload,
    id: string,
    eventData: UpdateEventDTO
  ): Promise<Event> {
    const existingEvent = await this.eventModel
      .findOne({ _id: id, isDeleted: false })
      .exec();
    if (!existingEvent) {
      throw new NotFoundException(
        `Event with ID ${id} not found or has been deleted`
      );
    }

    await this.eventOwnershipService.assertCanManageEvent(currentUser, id);

    const effectiveStart = eventData.startDate ?? existingEvent.startDate;
    const effectiveEnd = eventData.endDate ?? existingEvent.endDate;

    if (
      eventData.status !== undefined &&
      eventData.status !== existingEvent.status
    ) {
      if (
        existingEvent.status === EventStatus.ENDED ||
        existingEvent.status === EventStatus.CANCELLED
      ) {
        throw new BadRequestException(
          `Không thể đổi trạng thái của event đang ở trạng thái "${existingEvent.status}"`
        );
      }
      if (eventData.status === EventStatus.ACTIVE) {
        // Same inventory checks as the dedicated publish endpoint — status
        // must not be settable to "active" via this generic update path
        // without passing the same validation, or it becomes a bypass.
        this.assertEventFieldsPublishable(
          eventData.title ?? existingEvent.title,
          eventData.location ?? existingEvent.location,
          effectiveStart,
          effectiveEnd
        );
        await this.assertInventoryPublishable(existingEvent._id, effectiveEnd);
      }
    }

    if (eventData.timeSlots !== undefined) {
      this.validateTimeSlots(eventData.timeSlots, effectiveStart, effectiveEnd);

      // Guard: ngăn xóa slot đang có booking active
      const removedSlotIds = existingEvent.timeSlots
        .filter(
          (existing) =>
            !eventData.timeSlots!.some(
              (incoming) =>
                incoming._id && incoming._id === existing._id.toString()
            )
        )
        .map((s) => s._id);

      if (removedSlotIds.length > 0) {
        const checks = await Promise.all(
          removedSlotIds.map(async (slotId) => {
            const slot = existingEvent.timeSlots.find((s) =>
              s._id.equals(slotId)
            );
            const count = await this.bookingModel.countDocuments({
              timeSlotId: slotId,
              status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
              isDeleted: false,
            });
            return { label: slot?.label ?? slotId.toString(), count };
          })
        );
        const blocked = checks.filter((c) => c.count > 0);
        if (blocked.length > 0) {
          const details = blocked
            .map((b) => `"${b.label}" (${b.count} vé)`)
            .join(", ");
          throw new BadRequestException(
            `Không thể xóa khung giờ đang có vé đặt: ${details}`
          );
        }
      }
    }

    const updatedEvent = await this.eventModel
      .findByIdAndUpdate(
        id,
        {
          ...eventData,
          ...(eventData.thumbnail === null ? { thumbnail: "" } : {}),
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
        { new: true }
      )
      .exec();

    if (!updatedEvent) {
      throw new NotFoundException(`Event with ID ${id} not found`);
    }
    await this.invalidateEventCache(id);
    return updatedEvent;
  }

  async deleteEvent(id: string): Promise<Event> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid event ID");
    }

    const activeBookings = await this.bookingModel.countDocuments({
      eventId: new Types.ObjectId(id),
      status: { $in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
      isDeleted: false,
    });

    if (activeBookings > 0) {
      throw new BadRequestException(
        "Cancel all active bookings before deleting this event"
      );
    }

    const session = await this.eventModel.db.startSession();

    try {
      let deletedEvent: Event | null = null;
      await session.withTransaction(async () => {
        const existingEvent = await this.eventModel
          .findOne({ _id: id, isDeleted: false })
          .session(session)
          .exec();

        if (!existingEvent) {
          throw new NotFoundException(
            `Event with ID ${id} not found or has already been deleted`
          );
        }

        existingEvent.isDeleted = true;
        deletedEvent = await existingEvent.save({ session });

        await this.zoneModel.updateMany(
          { eventId: existingEvent._id, isDeleted: false },
          { $set: { isDeleted: true } },
          { session }
        );

        await this.areaModel.updateMany(
          { eventId: existingEvent._id, isDeleted: false },
          { $set: { isDeleted: true } },
          { session }
        );
      });

      if (!deletedEvent) {
        throw new NotFoundException(
          `Event with ID ${id} not found or has already been deleted`
        );
      }

      await this.invalidateEventCache(id);
      return deletedEvent;
    } finally {
      await session.endSession();
    }
  }

  async restoreEvent(id: string): Promise<Event> {
    const session = await this.eventModel.db.startSession();

    try {
      let restoredEvent: Event | null = null;
      await session.withTransaction(async () => {
        const existingEvent = await this.eventModel
          .findOne({ _id: id, isDeleted: true })
          .session(session)
          .exec();

        if (!existingEvent) {
          throw new NotFoundException(`Deleted event with ID ${id} not found`);
        }

        existingEvent.isDeleted = false;
        restoredEvent = await existingEvent.save({ session });

        await this.zoneModel.updateMany(
          { eventId: existingEvent._id, isDeleted: true },
          { $set: { isDeleted: false } },
          { session }
        );

        await this.areaModel.updateMany(
          { eventId: existingEvent._id, isDeleted: true },
          { $set: { isDeleted: false } },
          { session }
        );
      });

      if (!restoredEvent) {
        throw new NotFoundException(`Deleted event with ID ${id} not found`);
      }

      await this.invalidateEventCache(id);
      return restoredEvent;
    } finally {
      await session.endSession();
    }
  }

  /**
   * Cancel an entire event and issue refunds for all confirmed+paid bookings.
   *
   * Strategy: set event status → CANCELLED first (atomic), then process bookings
   * in batches. Each batch cancels bookings via BookingService.adminCancelBooking
   * which handles Stripe/PayPal refunds. Partial failures are collected and returned
   * so the caller can retry or escalate specific bookings.
   */
  async cancelEventWithRefund(
    eventId: string,
    adminId: string,
    reason?: string
  ): Promise<{
    event: Event;
    totalBookings: number;
    cancelled: number;
    failed: Array<{ bookingId: string; error: string }>;
  }> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }

    const event = await this.eventModel.findOneAndUpdate(
      {
        _id: new Types.ObjectId(eventId),
        isDeleted: false,
        status: { $nin: [EventStatus.CANCELLED] },
      },
      { $set: { status: EventStatus.CANCELLED } },
      { new: true }
    );

    if (!event) {
      throw new NotFoundException(
        "Event not found, already cancelled, or has been deleted"
      );
    }

    this.logger.log(
      `cancelEventWithRefund: eventId=${eventId} adminId=${adminId} reason="${reason ?? ""}"`
    );

    const cancellationReason = reason ?? `Event cancelled by admin`;
    const failed: Array<{ bookingId: string; error: string }> = [];
    let cancelled = 0;
    let lastId: Types.ObjectId | null = null;

    // Cursor-based batching — avoids loading all booking IDs into memory
    for (;;) {
      const filter: any = {
        eventId: new Types.ObjectId(eventId),
        status: { $nin: [BookingStatus.CANCELLED, BookingStatus.EXPIRED] },
        isDeleted: false,
      };
      if (lastId) {
        filter._id = { $gt: lastId };
      }

      const batch = await this.bookingModel
        .find(filter)
        .select("_id")
        .sort({ _id: 1 })
        .limit(CANCEL_BATCH_SIZE)
        .lean();

      if (!batch.length) break;

      for (const booking of batch) {
        const bookingId = (booking._id as Types.ObjectId).toString();
        try {
          await this.bookingService.adminCancelBooking(
            bookingId,
            adminId,
            cancellationReason
          );
          cancelled++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : "unknown error";
          this.logger.error(
            `cancelEventWithRefund: failed booking=${bookingId} error="${msg}"`
          );
          failed.push({ bookingId, error: msg });
        }
      }

      lastId = batch[batch.length - 1]._id as Types.ObjectId;
      if (batch.length < CANCEL_BATCH_SIZE) break;
    }

    const totalBookings = cancelled + failed.length;
    this.logger.log(
      `cancelEventWithRefund: done eventId=${eventId} total=${totalBookings} cancelled=${cancelled} failed=${failed.length}`
    );

    return { event, totalBookings, cancelled, failed };
  }
}
