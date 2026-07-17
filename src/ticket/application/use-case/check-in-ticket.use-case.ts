import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { AuditService } from "@src/audit/audit.service";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { AuditAction } from "@src/schemas/audit-log.schema";
import { CheckInLog } from "@src/schemas/checkin-log.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { validateTimeSlotWindow } from "@src/ticket/domain/policies/ticket-time-slot.policy";
import { TicketCacheService } from "@src/ticket/infrastructure/cache/ticket-cache.service";
import { TicketPublisherService } from "@src/ticket/infrastructure/realtime/ticket-publisher.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import {
  TicketCheckInResult,
  TicketEventAccess,
} from "@src/ticket/types/ticket.types";
import { ClientSession, Model, Types } from "mongoose";

type TicketWithEventAccess = Omit<Ticket, "eventId"> & {
  _id: Types.ObjectId;
  eventId: TicketEventAccess;
};

@Injectable()
export class CheckInTicketUseCase {
  private readonly logger = new Logger(CheckInTicketUseCase.name);

  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(CheckInLog.name)
    private readonly checkInLogModel: Model<CheckInLog>,
    private readonly auditService: AuditService,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly ticketCache: TicketCacheService,
    private readonly ticketPublisher: TicketPublisherService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(
    ticketCode: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    currentUser: JwtPayload
  ): Promise<TicketCheckInResult> {
    const adminId = currentUser.userId;
    const dbSession = await this.ticketModel.db.startSession();
    const checkInResult: { updatedTicket?: Ticket } = {};
    let ticketId: Types.ObjectId | null = null;

    try {
      await dbSession.withTransaction(async () => {
        const ticket = (await this.ticketModel
          .findOne({ ticketCode, isDeleted: false })
          .populate<{ eventId: TicketEventAccess }>(
            "eventId",
            "startDate endDate timeSlots createdBy organizerIds staffIds"
          )
          .session(dbSession)
          .exec()) as TicketWithEventAccess | null;

        if (!ticket) {
          throw new BadRequestException(
            "Ticket không hợp lệ hoặc đã được check-in"
          );
        }

        ticketId = ticket._id as Types.ObjectId;

        if (!ticket.eventId) {
          throw new BadRequestException("Event not found");
        }

        if (
          !this.eventOwnershipService.hasCheckInAccess(
            currentUser,
            ticket.eventId
          )
        ) {
          throw new ForbiddenException(
            "You are not allowed to check in tickets for this event"
          );
        }

        if (ticket.status !== "valid") {
          const reason =
            ticket.status === "used"
              ? "Vé đã được check-in bởi thiết bị khác"
              : ticket.status === "expired"
                ? "Vé đã hết hạn"
                : "Vé không hợp lệ vì đã bị hủy hoặc hoàn tiền";

          await this.writeCheckInLog(
            ticket._id as Types.ObjectId,
            adminId,
            location,
            deviceInfo,
            ipAddress,
            false,
            `Failed: ticket is ${ticket.status}`,
            dbSession
          );
          throw new BadRequestException(reason);
        }

        const event = ticket.eventId;
        const now = new Date();

        if (now < event.startDate) {
          throw new BadRequestException(
            "Sự kiện chưa bắt đầu, không thể check-in"
          );
        }

        if (now > event.endDate) {
          await this.ticketModel.updateOne(
            { _id: ticket._id, status: "valid", isDeleted: false },
            { $set: { status: "expired" } },
            { session: dbSession }
          );
          throw new BadRequestException("Sự kiện đã kết thúc, vé đã hết hạn");
        }

        await this.assertTimeSlotAllowsCheckIn(
          ticket,
          event,
          now,
          adminId,
          location,
          deviceInfo,
          ipAddress,
          dbSession
        );

        const updatedTicket = await this.ticketModel.findOneAndUpdate(
          { _id: ticket._id, status: "valid", isDeleted: false },
          {
            $set: {
              status: "used",
              checkedInAt: now,
              checkInLocation: location,
              checkedInBy: new Types.ObjectId(adminId),
              metadata: { deviceInfo, ipAddress },
            },
          },
          { new: true, session: dbSession }
        );

        if (!updatedTicket) {
          await this.recordConcurrentCheckInFailure(
            ticket._id as Types.ObjectId,
            adminId,
            location,
            deviceInfo,
            ipAddress,
            dbSession
          );
        }

        checkInResult.updatedTicket = updatedTicket as Ticket;

        await this.writeCheckInLog(
          ticket._id as Types.ObjectId,
          adminId,
          location,
          deviceInfo,
          ipAddress,
          true,
          "Check-in success",
          dbSession
        );
      });
    } finally {
      await dbSession.endSession();
    }

    if (!checkInResult.updatedTicket) {
      throw new BadRequestException(
        "Ticket không hợp lệ hoặc đã được check-in"
      );
    }

    const checkedInTicket = checkInResult.updatedTicket;
    await Promise.all([
      this.ticketCache.invalidateTicketCache(),
      this.ticketCache.invalidateUserTicketCache(
        checkedInTicket.userId?.toString() ?? ""
      ),
    ]);

    this.ticketPublisher.emitTicketCheckedIn({
      ticketCode: checkedInTicket.ticketCode,
      eventId: checkedInTicket.eventId,
      zoneId: checkedInTicket.zoneId,
      seatNumber: checkedInTicket.seatNumber || null,
      checkedInAt: checkedInTicket.checkedInAt as Date,
    });

    await this.recordAudit(
      checkedInTicket.ticketCode,
      ticketId,
      adminId,
      currentUser.role,
      location,
      deviceInfo,
      ipAddress
    );

    return this.ticketPresenter.ticketCheckInResult(checkedInTicket);
  }

  private async assertTimeSlotAllowsCheckIn(
    ticket: TicketWithEventAccess,
    event: TicketEventAccess,
    now: Date,
    adminId: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    dbSession: ClientSession
  ): Promise<void> {
    if (!ticket.timeSlotId) {
      return;
    }

    const slot = event.timeSlots?.find(
      (item) => item._id.toString() === ticket.timeSlotId!.toString()
    );
    if (!slot) {
      await this.writeCheckInLog(
        ticket._id as Types.ObjectId,
        adminId,
        location,
        deviceInfo,
        ipAddress,
        false,
        "Failed: time slot no longer exists on event",
        dbSession
      );
      throw new BadRequestException(
        "Khung giờ của vé này không còn tồn tại trong sự kiện"
      );
    }

    const check = validateTimeSlotWindow(slot, now);
    if (!check.valid) {
      await this.writeCheckInLog(
        ticket._id as Types.ObjectId,
        adminId,
        location,
        deviceInfo,
        ipAddress,
        false,
        `Failed: outside time slot window — ${check.message}`,
        dbSession
      );
      throw new BadRequestException(check.message);
    }
  }

  private async recordConcurrentCheckInFailure(
    ticketId: Types.ObjectId,
    adminId: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    dbSession: ClientSession
  ): Promise<never> {
    const current = await this.ticketModel
      .findOne({ _id: ticketId, isDeleted: false })
      .select("status")
      .session(dbSession)
      .lean()
      .exec();

    const isExpired = current?.status === "expired";
    const isCancelled = current?.status === "cancelled";
    await this.writeCheckInLog(
      ticketId,
      adminId,
      location,
      deviceInfo,
      ipAddress,
      false,
      isExpired
        ? "Failed: ticket expired concurrently"
        : isCancelled
          ? "Failed: ticket was cancelled"
          : "Failed: already used by another device",
      dbSession
    );

    throw new BadRequestException(
      isExpired
        ? "Vé đã hết hạn"
        : isCancelled
          ? "Vé không hợp lệ vì đã bị hủy hoặc hoàn tiền"
          : "Vé đã được check-in bởi thiết bị khác"
    );
  }

  private async writeCheckInLog(
    ticketId: Types.ObjectId,
    adminId: string,
    location: string,
    deviceInfo: string,
    ipAddress: string,
    success: boolean,
    message: string,
    dbSession: ClientSession
  ): Promise<void> {
    await this.checkInLogModel.create(
      [
        {
          ticketId,
          adminId,
          location,
          deviceInfo,
          ipAddress,
          success,
          message,
        },
      ],
      { session: dbSession }
    );
  }

  private async recordAudit(
    ticketCode: string,
    ticketId: Types.ObjectId | null,
    adminId: string,
    actorRole: string,
    location: string,
    deviceInfo: string,
    ipAddress: string
  ): Promise<void> {
    try {
      await this.auditService.record({
        action: AuditAction.TICKET_CHECKIN,
        actorId: adminId,
        actorRole,
        ticketId: ticketId ? ticketId.toString() : undefined,
        ipAddress,
        metadata: { location, deviceInfo, ticketCode },
      });
    } catch (auditErr) {
      this.logger.error(
        `checkInTicket audit failed for ticketCode=${ticketCode}: ${(auditErr as Error)?.message ?? String(auditErr)}. MANUAL AUDIT REQUIRED.`
      );
    }
  }
}
