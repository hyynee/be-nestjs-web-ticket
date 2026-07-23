import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { TicketService } from "@src/ticket/ticket.service";
import { RegenerateQrResult } from "@src/admin-ops/domain/types/admin-ops.types";

@Injectable()
export class RegenerateTicketQrAdminUseCase {
  constructor(
    private readonly ticketService: TicketService,
    private readonly auditService: AuditService
  ) {}

  async execute(
    ticketCode: string,
    admin: JwtPayload
  ): Promise<RegenerateQrResult> {
    const ticket = await this.ticketService.regenerateQrCode(ticketCode);

    await this.auditService.record({
      action: AuditAction.ADMIN_TICKET_REGENERATE_QR,
      actorId: admin.userId,
      actorRole: admin.role,
      ticketId: ticket.id,
      reason: `Admin regenerated QR code for ticket ${ticket.ticketCode}`,
      metadata: { ticketCode: ticket.ticketCode },
    });

    return ticket;
  }
}
