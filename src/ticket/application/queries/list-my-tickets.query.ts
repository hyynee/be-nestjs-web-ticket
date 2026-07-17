import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { Ticket } from "@src/schemas/ticket.schema";
import { MyTicketsQueryDto } from "@src/ticket/dto/my-tickets-query.dto";
import { TicketCacheService } from "@src/ticket/infrastructure/cache/ticket-cache.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import {
  TicketListItem,
  TicketViewSource,
} from "@src/ticket/types/ticket.types";
import { FilterQuery, Model, PipelineStage, Types } from "mongoose";

@Injectable()
export class ListMyTicketsQuery {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly ticketCache: TicketCacheService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(
    userId: string,
    query: MyTicketsQueryDto
  ): Promise<PaginatedResponse<TicketListItem>> {
    const normalizedQuery = this.normalizeQuery(query);
    const { page, limit } = normalizedQuery;
    const cacheKey = this.ticketCache.generateUserCacheKey(
      userId,
      normalizedQuery
    );
    const cached =
      await this.ticketCache.getJson<PaginatedResponse<TicketListItem>>(
        cacheKey
      );
    if (cached) {
      return cached;
    }

    const filter = this.buildFilter(userId, normalizedQuery);
    const skip = (page - 1) * limit;
    const sort = this.buildSort(
      normalizedQuery.sortBy,
      normalizedQuery.sortOrder
    );

    const [tickets, total] = await Promise.all([
      this.ticketModel.aggregate<TicketViewSource>([
        { $match: filter },
        { $sort: sort },
        { $skip: skip },
        { $limit: limit },
        ...this.lookupStages(),
      ]),
      this.ticketModel.countDocuments(filter),
    ]);

    const result = this.ticketPresenter.ticketPage(tickets, page, limit, total);
    await this.ticketCache.cacheUserList(userId, cacheKey, result);
    return result;
  }

  private normalizeQuery(
    query: MyTicketsQueryDto
  ): Required<MyTicketsQueryDto> {
    return {
      bookingId: query.bookingId,
      eventId: query.eventId,
      status: query.status,
      ticketCode: query.ticketCode,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
      sortBy: query.sortBy ?? "createdAt",
      sortOrder: query.sortOrder ?? "desc",
    } as Required<MyTicketsQueryDto>;
  }

  private buildFilter(
    userId: string,
    query: MyTicketsQueryDto
  ): FilterQuery<Ticket> {
    const filter: FilterQuery<Ticket> = {
      userId: new Types.ObjectId(userId),
      isDeleted: false,
    };

    if (query.bookingId) filter.bookingId = new Types.ObjectId(query.bookingId);
    if (query.eventId) filter.eventId = new Types.ObjectId(query.eventId);
    if (query.status) filter.status = query.status;
    if (query.ticketCode) {
      filter.ticketCode = {
        $regex: escapeRegex(query.ticketCode.trim()),
        $options: "i",
      };
    }

    return filter;
  }

  private buildSort(
    sortBy?: string,
    sortOrder?: string
  ): Record<string, 1 | -1> {
    const allowedSortFields = ["createdAt", "price", "status"];
    const finalSortBy =
      sortBy && allowedSortFields.includes(sortBy) ? sortBy : "createdAt";

    return {
      [finalSortBy]: sortOrder === "asc" ? 1 : -1,
    };
  }

  private lookupStages(): PipelineStage[] {
    return [
      {
        $lookup: {
          from: "events",
          localField: "eventId",
          foreignField: "_id",
          as: "eventId",
          pipeline: [
            { $project: { title: 1, startDate: 1, endDate: 1, location: 1 } },
          ],
        },
      },
      {
        $lookup: {
          from: "bookings",
          localField: "bookingId",
          foreignField: "_id",
          as: "bookingId",
          pipeline: [{ $project: { bookingCode: 1 } }],
        },
      },
      {
        $lookup: {
          from: "zones",
          localField: "zoneId",
          foreignField: "_id",
          as: "zoneId",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $lookup: {
          from: "areas",
          localField: "areaId",
          foreignField: "_id",
          as: "areaId",
          pipeline: [{ $project: { name: 1 } }],
        },
      },
      {
        $addFields: {
          eventId: { $ifNull: [{ $arrayElemAt: ["$eventId", 0] }, null] },
          bookingId: { $ifNull: [{ $arrayElemAt: ["$bookingId", 0] }, null] },
          zoneId: { $ifNull: [{ $arrayElemAt: ["$zoneId", 0] }, null] },
          areaId: { $ifNull: [{ $arrayElemAt: ["$areaId", 0] }, null] },
        },
      },
    ];
  }
}
