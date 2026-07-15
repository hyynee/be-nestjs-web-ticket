import { Injectable } from "@nestjs/common";
import { Inject } from "@nestjs/common";
import { QueueService } from "@src/queue/queue.service";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { Ticket } from "@src/schemas/ticket.schema";
import { Zone } from "@src/schemas/zone.schema";
import { ExportTicketDto } from "./dto/export-ticket.dto";
import { Response } from "express";
import { exportCSV, exportExcel } from "@src/helper/export.helper";
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

@Injectable()
export class ExportService {
  constructor(
    @InjectModel(Ticket.name) private ticketModel: Model<Ticket>,
    @InjectModel(Zone.name) private zoneModel: Model<Zone>,
    @Inject(QueueService) private readonly queueService: QueueService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}
  private async exportByFormat(
    data: ExportRow[],
    format: string,
    res: Response,
    fileName: string
  ) {
    // Handle empty data
    if (!data || data.length === 0) {
      const emptyData = [{ message: "No data to export" }];
      if (format === "csv") {
        const csv = exportCSV(emptyData, ["message"]);
        res.setHeader("Content-Type", "text/csv");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename=${fileName}.csv`
        );
        return res.send(csv);
      }

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=${fileName}.xlsx`
      );

      return exportExcel(
        emptyData,
        [{ header: "message", key: "message" }],
        res,
        fileName
      );
    }

    const firstRow = data[0] ?? {};
    const fields = Object.keys(firstRow);

    if (format === "csv") {
      const csv = exportCSV(data, fields);
      res.setHeader("Content-Type", "text/csv");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=${fileName}.csv`
      );
      return res.send(csv);
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${fileName}.xlsx`
    );

    return exportExcel(
      data,
      fields.map((key) => ({ header: key, key })),
      res,
      fileName
    );
  }

  private async getTicketData(dto: ExportTicketDto) {
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
      .lean<TicketExportLean[]>()
      .exec();

    return tickets.map<ExportRow>((ticket) => ({
      ticketCode: ticket.ticketCode,
      eventTitle: ticket.eventId?.title || "N/A",
      zoneName: ticket.zoneId?.name || "N/A",
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

  private async getCheckInZoneData(dto: ExportCheckInDto) {
    const id = new Types.ObjectId(dto.eventId);

    const zones = await this.zoneModel
      .find({ eventId: id })
      .lean<ZoneExportLean[]>()
      .exec();
    const data = await Promise.all(
      zones.map(async (zone) => {
        const checkInCount = await this.ticketModel.countDocuments({
          zoneId: zone._id,
          status: "used",
          isDeleted: false,
        });
        return {
          zoneName: zone.name || "N/A",
          totalCheckIns: checkInCount,
          capacity: zone.capacity || "N/A",
        };
      })
    );
    return data;
  }

  async getTicketExportData(dto: ExportTicketDto): Promise<ExportRow[]> {
    return this.getTicketData(dto);
  }

  async getCheckInZoneExportData(dto: ExportCheckInDto): Promise<ExportRow[]> {
    return this.getCheckInZoneData(dto);
  }

  async exportCheckInZones(
    dto: ExportCheckInDto,
    currentUser: JwtPayload,
    res: Response
  ) {
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      dto.eventId
    );
    await this.queueService.addJob({
      type: "export-checkin-zones",
      payload: { dto, requestedByUserId: currentUser.userId },
      requestedAt: new Date().toISOString(),
    });
    return res.status(202).json({
      message: "Export đang được xử lý. Bạn sẽ nhận được file qua email.",
      status: "queued",
    });
  }

  async exportTickets(
    dto: ExportTicketDto,
    currentUser: JwtPayload,
    res: Response
  ) {
    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      dto.eventId
    );
    await this.queueService.addJob({
      type: "export-tickets",
      payload: { dto, requestedByUserId: currentUser.userId },
      requestedAt: new Date().toISOString(),
    });
    return res.status(202).json({
      message: "Export đang được xử lý. Bạn sẽ nhận được file qua email.",
      status: "queued",
    });
  }
}
