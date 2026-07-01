import { Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import { AuditLog, AuditAction } from "@src/schemas/audit-log.schema";

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
}
