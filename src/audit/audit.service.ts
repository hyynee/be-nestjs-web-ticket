import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { FilterQuery, Model, Types } from "mongoose";
import { AuditLog, AuditAction } from "@src/schemas/audit-log.schema";
import { QueryAuditLogDto } from "./dto/query-audit-log.dto";
import { sanitizeSensitiveFields } from "@src/helper/sanitize.helper";
import { exportCSV } from "@src/helper/export.helper";

export interface AuditEntry {
  action: AuditAction;
  actorId: string;
  actorRole?: string;
  bookingId?: string;
  eventId?: string;
  ticketId?: string;
  reason?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}

type PopulatedActor = {
  _id: Types.ObjectId;
  email?: string;
  fullName?: string;
  role?: string;
};

export interface AuditLogListItem {
  id: string;
  action: AuditAction;
  actor: { id: string; email?: string; fullName?: string; role?: string };
  bookingId?: string;
  eventId?: string;
  ticketId?: string;
  reason?: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
  createdAt: Date;
}

export const AUDIT_EXPORT_MAX_ROWS = 20_000;
const AUDIT_EXPORT_FIELDS = [
  "id",
  "createdAt",
  "action",
  "actorId",
  "actorEmail",
  "actorRole",
  "bookingId",
  "eventId",
  "ticketId",
  "reason",
  "ipAddress",
] as const;

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectModel(AuditLog.name) private readonly auditLogModel: Model<AuditLog>
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.auditLogModel.create({
        action: entry.action,
        actorId: new Types.ObjectId(entry.actorId),
        actorRole: entry.actorRole,
        bookingId: entry.bookingId
          ? new Types.ObjectId(entry.bookingId)
          : undefined,
        eventId: entry.eventId ? new Types.ObjectId(entry.eventId) : undefined,
        ticketId: entry.ticketId
          ? new Types.ObjectId(entry.ticketId)
          : undefined,
        reason: entry.reason,
        ipAddress: entry.ipAddress,
        metadata: entry.metadata,
      });
    } catch (err) {
      this.logger.error(
        `AuditService.record failed — action=${entry.action} actor=${entry.actorId}: ${(err as Error)?.message}`
      );
    }
  }

  async findAll(query: QueryAuditLogDto): Promise<{
    data: AuditLogListItem[];
    page: number;
    limit: number;
    total: number;
  }> {
    const filter = this.buildFilter(query);
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder === "asc" ? 1 : -1;

    const [rows, total] = await Promise.all([
      this.auditLogModel
        .find(filter)
        .sort({ [sortBy]: sortOrder })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate<{ actorId: PopulatedActor }>("actorId", "email fullName role")
        .lean(),
      this.auditLogModel.countDocuments(filter),
    ]);

    return {
      data: rows.map((row) => this.toListItem(row)),
      page,
      limit,
      total,
    };
  }

  async findById(id: string): Promise<AuditLogListItem> {
    if (!Types.ObjectId.isValid(id)) {
      throw new BadRequestException("Invalid audit log id");
    }

    const row = await this.auditLogModel
      .findById(id)
      .populate<{ actorId: PopulatedActor }>("actorId", "email fullName role")
      .lean();

    if (!row) {
      throw new NotFoundException("Audit log not found");
    }

    return this.toListItem(row);
  }

  async exportCsv(query: QueryAuditLogDto): Promise<string> {
    const filter = this.buildFilter(query);
    const sortBy = query.sortBy ?? "createdAt";
    const sortOrder = query.sortOrder === "asc" ? 1 : -1;

    const rows = await this.auditLogModel
      .find(filter)
      .sort({ [sortBy]: sortOrder })
      .limit(AUDIT_EXPORT_MAX_ROWS + 1)
      .populate<{ actorId: PopulatedActor }>("actorId", "email fullName role")
      .lean();

    if (rows.length > AUDIT_EXPORT_MAX_ROWS) {
      throw new BadRequestException(
        `Export quá lớn (>${AUDIT_EXPORT_MAX_ROWS.toLocaleString()} dòng). Vui lòng lọc theo action/actorId/khoảng thời gian nhỏ hơn.`
      );
    }

    const exportRows = rows.map((row) => {
      const item = this.toListItem(row);
      return {
        id: item.id,
        createdAt: item.createdAt.toISOString(),
        action: item.action,
        actorId: item.actor.id,
        actorEmail: item.actor.email ?? "",
        actorRole: item.actor.role ?? "",
        bookingId: item.bookingId ?? "",
        eventId: item.eventId ?? "",
        ticketId: item.ticketId ?? "",
        reason: item.reason ?? "",
        ipAddress: item.ipAddress ?? "",
      };
    });

    return exportCSV(exportRows, [...AUDIT_EXPORT_FIELDS]);
  }

  private buildFilter(query: QueryAuditLogDto): FilterQuery<AuditLog> {
    const filter: FilterQuery<AuditLog> = {};

    if (query.action) filter.action = query.action;
    if (query.actorId) filter.actorId = new Types.ObjectId(query.actorId);
    if (query.eventId) filter.eventId = new Types.ObjectId(query.eventId);
    if (query.bookingId) filter.bookingId = new Types.ObjectId(query.bookingId);
    if (query.ticketId) filter.ticketId = new Types.ObjectId(query.ticketId);

    if (query.from || query.to) {
      filter.createdAt = {};
      if (query.from) filter.createdAt.$gte = new Date(query.from);
      if (query.to) filter.createdAt.$lte = new Date(query.to);
    }

    return filter;
  }

  private toListItem(row: any): AuditLogListItem {
    const actor = row.actorId as PopulatedActor | Types.ObjectId | undefined;
    const isPopulated =
      !!actor && typeof actor === "object" && "email" in actor;

    return {
      id: String(row._id),
      action: row.action,
      actor: {
        id: isPopulated
          ? String((actor as PopulatedActor)._id)
          : String(actor ?? ""),
        email: isPopulated ? (actor as PopulatedActor).email : undefined,
        fullName: isPopulated ? (actor as PopulatedActor).fullName : undefined,
        role: isPopulated ? (actor as PopulatedActor).role : undefined,
      },
      bookingId: row.bookingId ? String(row.bookingId) : undefined,
      eventId: row.eventId ? String(row.eventId) : undefined,
      ticketId: row.ticketId ? String(row.ticketId) : undefined,
      reason: row.reason,
      ipAddress: row.ipAddress,
      metadata: row.metadata
        ? (sanitizeSensitiveFields(row.metadata) as Record<string, unknown>)
        : undefined,
      createdAt: row.createdAt,
    };
  }
}
