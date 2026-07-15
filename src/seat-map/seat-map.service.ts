import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { Zone } from "@src/schemas/zone.schema";
import { Area } from "@src/schemas/area.schema";
import { Booking, BookingStatus, SeatLock } from "@src/schemas/booking.schema";
import { SeatState, SeatBlockStatus } from "@src/schemas/seat-state.schema";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { ZoneGateway } from "@src/zone/zone.gateway";
import { BlockSeatsDto } from "./dto/block-seats.dto";
import { UnblockSeatsDto } from "./dto/unblock-seats.dto";

export type SeatMapSeatStatus =
  "available" | "holding" | "sold" | "blocked" | "disabled";

export interface SeatMapSeat {
  seat: string;
  status: SeatMapSeatStatus;
}

export interface SeatMapArea {
  areaId: Types.ObjectId;
  areaName: string;
  seats: SeatMapSeat[];
}

export interface SeatMapZone {
  zoneId: Types.ObjectId;
  zoneName: string;
  hasSeating: boolean;
  capacity: number;
  soldCount: number;
  availableTickets: number;
  areas?: SeatMapArea[];
}

type AreaLean = {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
  zoneId: Types.ObjectId;
  name: string;
  seats?: string[];
};

@Injectable()
export class SeatMapService {
  constructor(
    @InjectModel(Zone.name) private readonly zoneModel: Model<Zone>,
    @InjectModel(Area.name) private readonly areaModel: Model<Area>,
    @InjectModel(Booking.name) private readonly bookingModel: Model<Booking>,
    @InjectModel(SeatLock.name) private readonly seatLockModel: Model<SeatLock>,
    @InjectModel(SeatState.name)
    private readonly seatStateModel: Model<SeatState>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly auditService: AuditService,
    private readonly zoneGateway: ZoneGateway
  ) {}

  /** Computes the bookable state of a specific set of seats within one area. Priority: disabled > blocked > sold > holding > available. */
  private async computeSeatStatuses(
    area: AreaLean,
    seats: string[]
  ): Promise<SeatMapSeat[]> {
    if (seats.length === 0) return [];

    const [locks, overrides, soldBookings] = await Promise.all([
      this.seatLockModel
        .find({
          eventId: area.eventId,
          areaId: area._id,
          seat: { $in: seats },
          expiresAt: { $gt: new Date() },
        })
        .select("seat")
        .lean(),
      this.seatStateModel
        .find({
          eventId: area.eventId,
          zoneId: area.zoneId,
          areaId: area._id,
          seat: { $in: seats },
        })
        .select("seat status")
        .lean(),
      this.bookingModel
        .find({
          eventId: area.eventId,
          areaId: area._id,
          status: BookingStatus.CONFIRMED,
          isDeleted: false,
          seats: { $in: seats },
        })
        .select("seats")
        .lean(),
    ]);

    const holdingSeats = new Set(locks.map((lock) => lock.seat));
    const soldSeats = new Set(soldBookings.flatMap((booking) => booking.seats));
    const overrideBySeat = new Map(
      overrides.map((override) => [override.seat, override.status])
    );

    return seats.map((seat) => {
      const override = overrideBySeat.get(seat);
      let status: SeatMapSeatStatus;
      if (override === SeatBlockStatus.DISABLED) {
        status = "disabled";
      } else if (override === SeatBlockStatus.BLOCKED) {
        status = "blocked";
      } else if (soldSeats.has(seat)) {
        status = "sold";
      } else if (holdingSeats.has(seat)) {
        status = "holding";
      } else {
        status = "available";
      }
      return { seat, status };
    });
  }

  private async buildZoneSeatMap(zone: Zone): Promise<SeatMapZone> {
    const base: SeatMapZone = {
      zoneId: zone._id as Types.ObjectId,
      zoneName: zone.name,
      hasSeating: zone.hasSeating,
      capacity: zone.capacity,
      soldCount: zone.soldCount,
      availableTickets: Math.max(zone.capacity - zone.soldCount, 0),
    };

    if (!zone.hasSeating) {
      return base;
    }

    const areas = await this.areaModel
      .find({ zoneId: zone._id, isDeleted: false })
      .lean<AreaLean[]>();

    base.areas = await Promise.all(
      areas.map(async (area) => ({
        areaId: area._id,
        areaName: area.name,
        seats: await this.computeSeatStatuses(area, area.seats ?? []),
      }))
    );

    return base;
  }

  async getEventSeatMap(eventId: string): Promise<SeatMapZone[]> {
    if (!Types.ObjectId.isValid(eventId)) {
      throw new BadRequestException("Invalid event ID");
    }
    const zones = await this.zoneModel
      .find({ eventId: new Types.ObjectId(eventId), isDeleted: false })
      .lean<Zone[]>();
    return Promise.all(zones.map((zone) => this.buildZoneSeatMap(zone)));
  }

  async getZoneSeatMap(zoneId: string): Promise<SeatMapZone> {
    if (!Types.ObjectId.isValid(zoneId)) {
      throw new BadRequestException("Invalid zone ID");
    }
    const zone = await this.zoneModel
      .findOne({ _id: zoneId, isDeleted: false })
      .lean<Zone>();
    if (!zone) {
      throw new NotFoundException(`Zone with ID ${zoneId} not found`);
    }
    return this.buildZoneSeatMap(zone);
  }

  private async resolveAreaForMutation(
    zoneId: string,
    areaId: string
  ): Promise<AreaLean> {
    if (!Types.ObjectId.isValid(zoneId) || !Types.ObjectId.isValid(areaId)) {
      throw new BadRequestException("Invalid zone or area ID");
    }
    const area = await this.areaModel
      .findOne({ _id: areaId, zoneId, isDeleted: false })
      .lean<AreaLean>();
    if (!area) {
      throw new NotFoundException("Khu vực không tồn tại");
    }
    return area;
  }

  async blockSeats(
    currentUser: JwtPayload,
    dto: BlockSeatsDto
  ): Promise<{ seats: SeatMapSeat[] }> {
    const area = await this.resolveAreaForMutation(dto.zoneId, dto.areaId);
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      area.eventId.toString()
    );

    const validSeats = area.seats ?? [];
    const invalidSeats = dto.seats.filter((seat) => !validSeats.includes(seat));
    if (invalidSeats.length > 0) {
      throw new BadRequestException(
        `Ghế không tồn tại trong khu vực: ${invalidSeats.join(", ")}`
      );
    }

    const status = dto.status ?? SeatBlockStatus.BLOCKED;
    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : undefined;

    await this.seatStateModel.bulkWrite(
      dto.seats.map((seat) => ({
        updateOne: {
          filter: {
            eventId: area.eventId,
            zoneId: area.zoneId,
            areaId: area._id,
            seat,
          },
          update: {
            $set: {
              eventId: area.eventId,
              zoneId: area.zoneId,
              areaId: area._id,
              seat,
              status,
              reason: dto.reason,
              createdBy: new Types.ObjectId(currentUser.userId),
              expiresAt,
            },
          },
          upsert: true,
        },
      }))
    );

    await this.auditService.record({
      action: AuditAction.SEAT_BLOCK,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId: area.eventId.toString(),
      metadata: {
        zoneId: dto.zoneId,
        areaId: dto.areaId,
        seats: dto.seats,
        status,
      },
    });

    const seats = dto.seats.map((seat) => ({
      seat,
      status: status as SeatMapSeatStatus,
    }));
    this.zoneGateway.emitSeatMapUpdate({
      eventId: area.eventId,
      zoneId: area.zoneId,
      areaId: area._id,
      seats,
    });

    return { seats };
  }

  async unblockSeats(
    currentUser: JwtPayload,
    dto: UnblockSeatsDto
  ): Promise<{ seats: SeatMapSeat[] }> {
    const area = await this.resolveAreaForMutation(dto.zoneId, dto.areaId);
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      area.eventId.toString()
    );

    await this.seatStateModel.deleteMany({
      eventId: area.eventId,
      zoneId: area.zoneId,
      areaId: area._id,
      seat: { $in: dto.seats },
    });

    await this.auditService.record({
      action: AuditAction.SEAT_UNBLOCK,
      actorId: currentUser.userId,
      actorRole: currentUser.role,
      eventId: area.eventId.toString(),
      metadata: { zoneId: dto.zoneId, areaId: dto.areaId, seats: dto.seats },
    });

    // Recompute real state after removing the override — the seat may now
    // be available, or (rare) holding/sold if that changed concurrently.
    const seats = await this.computeSeatStatuses(area, dto.seats);
    this.zoneGateway.emitSeatMapUpdate({
      eventId: area.eventId,
      zoneId: area.zoneId,
      areaId: area._id,
      seats,
    });

    return { seats };
  }
}
