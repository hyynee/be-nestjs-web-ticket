import { ConflictException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { NotificationService } from "@src/notification/notification.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { RefundRequestStatus } from "@src/schemas/refund-request.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { Model, Types } from "mongoose";
import { CreateRefundRequestDto } from "../dto/create-refund-request.dto";
import { RefundPolicyService } from "../domain/policies/refund-policy.service";
import { RefundRequestDocument } from "../domain/types/refund-domain.types";
import { RefundRepository } from "../infrastructure/persistence/refund.repository";
import { RefundPresenter } from "../presenters/refund.presenter";
import type { RefundRequestDetail } from "../types/refund.types";

@Injectable()
export class CreateRefundRequestUseCase {
  constructor(
    private readonly repository: RefundRepository,
    private readonly policy: RefundPolicyService,
    private readonly presenter: RefundPresenter,
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly auditService: AuditService,
    private readonly notificationService: NotificationService
  ) {}

  async execute(
    user: JwtPayload,
    dto: CreateRefundRequestDto
  ): Promise<RefundRequestDetail> {
    const booking = await this.repository.loadBookingByCode(dto.bookingCode);
    this.policy.assertRequestOwner(user, booking);
    this.policy.assertBookingRefundable(booking);

    const amount = this.policy.resolveRefundAmount(booking, dto.amount);
    const usedTicketCount = await this.ticketModel.countDocuments({
      bookingId: booking._id,
      status: "used",
      isDeleted: false,
    });

    try {
      const [created] = await this.repository.createRequest({
        bookingId: booking._id,
        userId: booking.userId,
        eventId: booking.eventId,
        amount,
        reason: dto.reason.trim(),
        status: RefundRequestStatus.REQUESTED,
        metadata: {
          bookingCode: booking.bookingCode,
          usedTicketCount,
          hasUsedTickets: usedTicketCount > 0,
        },
      });

      await this.auditService.record({
        action: AuditAction.REFUND_REQUESTED,
        actorId: user.userId,
        actorRole: user.role,
        bookingId: booking._id.toString(),
        eventId: booking.eventId.toString(),
        reason: dto.reason,
        metadata: { amount },
      });

      await this.notificationService.notifyRefundRequested({
        userId: booking.userId,
        bookingId: booking._id.toString(),
        bookingCode: booking.bookingCode,
        eventId: booking.eventId.toString(),
        refundRequestId: (created._id as Types.ObjectId).toString(),
        amount,
      });

      return this.presenter.toDetail(created as RefundRequestDocument);
    } catch (error) {
      if (this.isDuplicateKeyError(error)) {
        throw new ConflictException(
          "A refund request is already active for this booking"
        );
      }
      throw error;
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === 11000
    );
  }
}
