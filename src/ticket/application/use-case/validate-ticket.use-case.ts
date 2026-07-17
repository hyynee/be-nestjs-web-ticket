import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Ticket } from "@src/schemas/ticket.schema";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { validateTimeSlotWindow } from "@src/ticket/domain/policies/ticket-time-slot.policy";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import {
  TicketEventAccess,
  TicketValidationResult,
} from "@src/ticket/types/ticket.types";
import { Model, Types } from "mongoose";

type TicketWithEventAccess = Omit<Ticket, "eventId"> & {
  _id: Types.ObjectId;
  eventId: TicketEventAccess;
};

@Injectable()
export class ValidateTicketUseCase {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(
    ticketCode: string,
    currentUser: JwtPayload
  ): Promise<TicketValidationResult> {
    const ticket = (await this.ticketModel
      .findOne({ ticketCode, isDeleted: false })
      .populate<{ eventId: TicketEventAccess }>(
        "eventId",
        "startDate endDate timeSlots createdBy organizerIds staffIds"
      )
      .exec()) as TicketWithEventAccess | null;
    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    const isOwnTicket = ticket.userId?.toString() === currentUser.userId;
    const canCheckIn =
      isOwnTicket ||
      (ticket.eventId &&
        this.eventOwnershipService.hasCheckInAccess(
          currentUser,
          ticket.eventId
        ));

    if (!canCheckIn) {
      throw new ForbiddenException(
        "You are not allowed to validate this ticket"
      );
    }

    if (ticket.status === "used") {
      return this.ticketPresenter.ticketValidation(
        false,
        "Vé đã được sử dụng",
        {
          usedAt: ticket.checkedInAt,
        }
      );
    }
    if (ticket.status === "cancelled") {
      return this.ticketPresenter.ticketValidation(false, "Vé đã bị hủy");
    }
    if (ticket.status === "expired") {
      return this.ticketPresenter.ticketValidation(false, "Vé đã hết hạn");
    }

    const event = ticket.eventId;
    if (!event) {
      throw new BadRequestException("Event not found for this ticket");
    }

    const windowValidation = this.validateEventWindow(ticket, event);
    if (!windowValidation.valid) {
      return windowValidation;
    }

    return this.ticketPresenter.ticketValidation(
      true,
      "Vé hợp lệ, có thể sử dụng",
      {
        ticket: this.ticketPresenter.toOptionalTicketListItem(ticket),
      }
    );
  }

  private validateEventWindow(
    ticket: TicketWithEventAccess,
    event: TicketEventAccess
  ): TicketValidationResult {
    const now = new Date();
    if (now < event.startDate) {
      return this.ticketPresenter.ticketValidation(
        false,
        "Sự kiện chưa bắt đầu, vé chưa thể sử dụng"
      );
    }
    if (now > event.endDate) {
      return this.ticketPresenter.ticketValidation(
        false,
        "Sự kiện đã kết thúc, vé không còn giá trị sử dụng"
      );
    }

    if (!ticket.timeSlotId) {
      return this.ticketPresenter.ticketValidation(true);
    }

    const slot = event.timeSlots?.find(
      (item) => item._id.toString() === ticket.timeSlotId!.toString()
    );
    if (!slot) {
      return this.ticketPresenter.ticketValidation(
        false,
        "Khung giờ của vé này không còn tồn tại trong sự kiện"
      );
    }

    const check = validateTimeSlotWindow(slot, now);
    if (!check.valid) {
      return this.ticketPresenter.ticketValidation(false, check.message);
    }

    return this.ticketPresenter.ticketValidation(true);
  }
}
