import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { QueueService } from "@src/queue/queue.service";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { Ticket } from "@src/schemas/ticket.schema";
import { Zone } from "@src/schemas/zone.schema";
import { ExportTicketDto } from "./dto/export-ticket.dto";
import { ExportCheckInDto } from "./dto/export-checkin.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";

type ExportCell = string | number | boolean | null;
type ExportRow = Record<string, ExportCell>;

type PopulatedTicketRef = {
  title?: string;
  name?: string;
  email?: string;
};

type TicketExportLean = {
  ticketCode: string;
  eventId?: PopulatedTicketRef | null;
  zoneId?: PopulatedTicketRef | null;
  userId?: PopulatedTicketRef | null;
  bookingId?: {
    snapshot?: { eventTitle: string; zoneName: string };
  } | null;
  seatNumber?: string | null;
  price: number;
  status: string;
  checkedInAt?: Date | string | null;
  checkInLocation?: string | null;
  createdAt?: Date | string | null;
};

type ZoneExportLean = {
  _id: Types.ObjectId;
  name?: string;
  capacity?: number | null;
};

type ZoneCheckInCount = {
  _id: Types.ObjectId;
  totalCheckIns: number;
};

interface ExportQueuedResult {
  message: string;
  status: "queued";
}

const EXPORT_QUEUED_RESULT: ExportQueuedResult = {
  message: "Export đang được xử lý. Bạn sẽ nhận được file qua email.",
  status: "queued",
};

@Injectable()
export class ExportService {
  constructor(
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @Inject(QueueService) private readonly queueService: QueueService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  private async getTicketData(dto: ExportTicketDto): Promise<ExportRow[]> {
    const filter: FilterQuery<Ticket> = { isDeleted: false };

    if (dto.eventId) {
      filter.eventId = new Types.ObjectId(dto.eventId);
    }

    if (dto.status) {
      filter.status = dto.status;
    }

    if (dto.zoneId) {
      filter.zoneId = new Types.ObjectId(dto.zoneId);
    }

    if (dto.startDate || dto.endDate) {
      const createdAtRange: { $gte?: Date; $lte?: Date } = {};
      if (dto.startDate) {
        createdAtRange.$gte = new Date(dto.startDate);
      }
      if (dto.endDate) {
        createdAtRange.$lte = new Date(dto.endDate);
      }
      filter.createdAt = createdAtRange;
    }

    const tickets = await this.ticketModel
      .find(filter)
      .populate("eventId", "title")
      .populate("zoneId", "name")
      .populate("userId", "email name")
      .populate("bookingId", "snapshot")
      .lean<TicketExportLean[]>()
      .exec();

    return tickets.map<ExportRow>((ticket) => ({
      ticketCode: ticket.ticketCode,
      // Prefer the booking's immutable snapshot (facts as of booking time)
      // over the live-populated Event/Zone — those can be edited after the
      // fact and an export run months later should reflect history, not
      // today's data. Falls back to the live populate for bookings created
      // before the snapshot field existed.
      eventTitle:
        ticket.bookingId?.snapshot?.eventTitle ||
        ticket.eventId?.title ||
        "N/A",
      zoneName:
        ticket.bookingId?.snapshot?.zoneName || ticket.zoneId?.name || "N/A",
      seatNumber: ticket.seatNumber || "N/A",
      price: ticket.price,
      status: ticket.status,
      userEmail: ticket.userId?.email || "N/A",
      userName: ticket.userId?.name || "N/A",
      checkedInAt: ticket.checkedInAt
        ? new Date(ticket.checkedInAt).toLocaleString()
        : "Not checked in",
      checkInLocation: ticket.checkInLocation || "N/A",
      createdAt: new Date(ticket.createdAt || new Date()).toLocaleString(),
    }));
  }

  private async getCheckInZoneData(
    dto: ExportCheckInDto
  ): Promise<ExportRow[]> {
    const id = new Types.ObjectId(dto.eventId);

    const zones = await this.zoneModel
      .find({ eventId: id })
      .lean<ZoneExportLean[]>()
      .exec();

    if (zones.length === 0) {
      return [];
    }

    const checkInCounts = await this.ticketModel
      .aggregate<ZoneCheckInCount>([
        {
          $match: {
            zoneId: { $in: zones.map((zone) => zone._id) },
            status: "used",
            isDeleted: false,
          },
        },
        {
          $group: {
            _id: "$zoneId",
            totalCheckIns: { $sum: 1 },
          },
        },
      ])
      .exec();

    const countByZoneId = new Map(
      checkInCounts.map((item) => [item._id.toString(), item.totalCheckIns])
    );

    return zones.map((zone) => ({
      zoneName: zone.name || "N/A",
      totalCheckIns: countByZoneId.get(zone._id.toString()) ?? 0,
      capacity: zone.capacity || "N/A",
    }));
  }

  async getTicketExportData(dto: ExportTicketDto): Promise<ExportRow[]> {
    return this.getTicketData(dto);
  }

  async getCheckInZoneExportData(dto: ExportCheckInDto): Promise<ExportRow[]> {
    return this.getCheckInZoneData(dto);
  }

  async exportCheckInZones(
    dto: ExportCheckInDto,
    currentUser: JwtPayload
  ): Promise<ExportQueuedResult> {
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      dto.eventId
    );
    await this.queueService.addJob({
      type: "export-checkin-zones",
      payload: { dto, requestedByUserId: currentUser.userId },
      requestedAt: new Date().toISOString(),
    });
    return EXPORT_QUEUED_RESULT;
  }

  async exportTickets(
    dto: ExportTicketDto,
    currentUser: JwtPayload
  ): Promise<ExportQueuedResult> {
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      dto.eventId
    );
    await this.queueService.addJob({
      type: "export-tickets",
      payload: { dto, requestedByUserId: currentUser.userId },
      requestedAt: new Date().toISOString(),
    });
    return EXPORT_QUEUED_RESULT;
  }
}
