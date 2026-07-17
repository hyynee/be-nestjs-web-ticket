import { BadRequestException, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { CheckInLog } from "@src/schemas/checkin-log.schema";
import { Ticket } from "@src/schemas/ticket.schema";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import {
  TicketCheckInHistoryEntry,
  TicketCheckInHistoryResult,
} from "@src/ticket/types/ticket.types";
import { Model, Types } from "mongoose";

@Injectable()
export class GetCheckInHistoryQuery {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    @InjectModel(CheckInLog.name)
    private readonly checkInLogModel: Model<CheckInLog>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(
    ticketCode: string,
    currentUser: JwtPayload
  ): Promise<TicketCheckInHistoryResult> {
    const ticket = await this.ticketModel
      .findOne({ ticketCode, isDeleted: false })
      .select("_id eventId")
      .lean()
      .exec();

    if (!ticket) {
      throw new BadRequestException("Ticket not found");
    }

    await this.eventOwnershipService.assertCanManageEvent(
      currentUser,
      (ticket.eventId as Types.ObjectId).toString()
    );

    const [eventResult, logs] = await Promise.all([
      this.ticketModel.aggregate([
        { $match: { _id: ticket._id } },
        {
          $lookup: {
            from: "events",
            localField: "eventId",
            foreignField: "_id",
            as: "event",
            pipeline: [{ $project: { title: 1 } }],
          },
        },
        {
          $project: {
            eventTitle: {
              $ifNull: [{ $arrayElemAt: ["$event.title", 0] }, ""],
            },
          },
        },
      ]),
      this.checkInLogModel.aggregate<TicketCheckInHistoryEntry>([
        { $match: { ticketId: ticket._id } },
        { $sort: { createdAt: -1 } },
        { $limit: 50 },
        {
          $lookup: {
            from: "users",
            localField: "adminId",
            foreignField: "_id",
            as: "adminId",
            pipeline: [{ $project: { name: 1 } }],
          },
        },
        {
          $addFields: {
            adminId: { $ifNull: [{ $arrayElemAt: ["$adminId", 0] }, null] },
          },
        },
      ]),
    ]);

    return this.ticketPresenter.checkInHistoryResult(
      ticketCode,
      (eventResult[0]?.eventTitle as string) ?? "",
      logs
    );
  }
}
