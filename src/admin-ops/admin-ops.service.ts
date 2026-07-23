import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { GetAnomaliesUseCase } from "./application/get-anomalies.use-case";
import { GetSystemSummaryUseCase } from "./application/get-system-summary.use-case";
import { RegenerateTicketQrAdminUseCase } from "./application/regenerate-ticket-qr.use-case";
import { ReissueTicketsUseCase } from "./application/reissue-tickets.use-case";
import { ResendConfirmationUseCase } from "./application/resend-confirmation.use-case";
import { AdminAnomalyQueryDto } from "./dto/admin-anomaly-query.dto";
import {
  AdminAnomalyResult,
  AdminSystemSummaryResult,
  RegenerateQrResult,
  ReissueTicketsResult,
  ResendConfirmationResult,
} from "./domain/types/admin-ops.types";

@Injectable()
export class AdminOpsService {
  constructor(
    private readonly getSystemSummary: GetSystemSummaryUseCase,
    private readonly getAnomalies: GetAnomaliesUseCase,
    private readonly reissueTickets: ReissueTicketsUseCase,
    private readonly resendConfirmation: ResendConfirmationUseCase,
    private readonly regenerateTicketQr: RegenerateTicketQrAdminUseCase
  ) {}

  getSystemSummaryResult(): Promise<AdminSystemSummaryResult> {
    return this.getSystemSummary.execute();
  }

  getAnomaliesResult(query: AdminAnomalyQueryDto): Promise<AdminAnomalyResult> {
    return this.getAnomalies.execute(query);
  }

  reissueTicketsForBooking(
    bookingCode: string,
    admin: JwtPayload
  ): Promise<ReissueTicketsResult> {
    return this.reissueTickets.execute(bookingCode, admin);
  }

  resendBookingConfirmation(
    bookingCode: string,
    admin: JwtPayload
  ): Promise<ResendConfirmationResult> {
    return this.resendConfirmation.execute(bookingCode, admin);
  }

  regenerateTicketQrCode(
    ticketCode: string,
    admin: JwtPayload
  ): Promise<RegenerateQrResult> {
    return this.regenerateTicketQr.execute(ticketCode, admin);
  }
}
