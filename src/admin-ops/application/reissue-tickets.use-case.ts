import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { TicketService } from "@src/ticket/ticket.service";
import { ReissueTicketsResult } from "@src/admin-ops/domain/types/admin-ops.types";

@Injectable()
export class ReissueTicketsUseCase {
  constructor(
    private readonly ticketService: TicketService,
    private readonly auditService: AuditService
  ) {}

  async execute(
    bookingCode: string,
    admin: JwtPayload
  ): Promise<ReissueTicketsResult> {
    // createTicketsFromBooking is idempotent — a booking that already has
    // tickets simply returns them, so this is safe to call as a general
    // "make sure this booking's tickets exist" admin action, not just for
    // the specific paid-without-ticket anomaly.
    const tickets =
      await this.ticketService.createTicketsFromBooking(bookingCode);

    await this.auditService.record({
      action: AuditAction.ADMIN_BOOKING_REISSUE_TICKETS,
      actorId: admin.userId,
      actorRole: admin.role,
      reason: `Admin reissued tickets for booking ${bookingCode}`,
      metadata: { bookingCode, ticketCount: tickets.length },
    });

    return { bookingCode: bookingCode.trim().toUpperCase(), tickets };
  }
}
