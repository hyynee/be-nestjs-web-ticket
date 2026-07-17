import { Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { PaginatedResponse } from "@src/common/interfaces/pagination-response";
import { escapeRegex } from "@src/common/utils/regex.utils";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { Ticket } from "@src/schemas/ticket.schema";
import { QueryTicketDto } from "@src/ticket/dto/query.dto";
import { TicketCacheService } from "@src/ticket/infrastructure/cache/ticket-cache.service";
import { TicketPresenter } from "@src/ticket/presenters/ticket.presenter";
import {
  TicketListItem,
  TicketViewSource,
} from "@src/ticket/types/ticket.types";
import { FilterQuery, Model, PipelineStage, Types } from "mongoose";

interface TicketScopeResult {
  scopedEventIds?: Types.ObjectId[];
  scopeKey: string;
}

@Injectable()
export class ListTicketsQuery {
  constructor(
    @InjectModel(Ticket.name) private readonly ticketModel: Model<Ticket>,
    private readonly eventOwnershipService: EventOwnershipService,
    private readonly ticketCache: TicketCacheService,
    private readonly ticketPresenter: TicketPresenter
  ) {}

  async execute(
    query: QueryTicketDto,
    currentUser: JwtPayload
  ): Promise<PaginatedResponse<TicketListItem>> {
    const normalizedQuery = this.normalizeQuery(query);
    const { page, limit } = normalizedQuery;
    const { scopedEventIds, scopeKey } = await this.resolveScope(
      normalizedQuery,
      currentUser
    );

    if (scopedEventIds?.length === 0) {
      return this.ticketPresenter.ticketPage([], page, limit, 0);
    }

    const cacheKey = this.ticketCache.generateListCacheKey(
      normalizedQuery,
      scopeKey
    );
    const cached =
      await this.ticketCache.getJson<PaginatedResponse<TicketListItem>>(
        cacheKey
      );
    if (cached) {
      return cached;
    }

    const filter = this.buildFilter(normalizedQuery, scopedEventIds);
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
    await this.ticketCache.cacheList(cacheKey, result);
    return result;
  }

  private normalizeQuery(query: QueryTicketDto): Required<QueryTicketDto> {
    return {
      eventId: query.eventId,
      zoneId: query.zoneId,
      areaId: query.areaId,
      userId: query.userId,
      ticketCode: query.ticketCode,
      status: query.status,
      page: query.page ?? 1,
      limit: query.limit ?? 10,
      sortBy: query.sortBy ?? "createdAt",
      sortOrder: query.sortOrder ?? "desc",
    } as Required<QueryTicketDto>;
  }

  private async resolveScope(
    query: QueryTicketDto,
    currentUser: JwtPayload
  ): Promise<TicketScopeResult> {
    if (currentUser.role === "admin") {
      return { scopeKey: query.eventId ? `event:${query.eventId}` : "admin" };
    }

    if (query.eventId) {
      await this.eventOwnershipService.assertCanManageEvent(
        currentUser,
        query.eventId
      );
      return { scopeKey: `event:${query.eventId}` };
    }

    const managedIds =
      await this.eventOwnershipService.getManagedEventIds(currentUser);
    return {
      scopedEventIds: managedIds,
      scopeKey: `user:${currentUser.userId}`,
    };
  }

  private buildFilter(
    query: QueryTicketDto,
    scopedEventIds?: Types.ObjectId[]
  ): FilterQuery<Ticket> {
    const filter: FilterQuery<Ticket> = { isDeleted: false };

    if (query.eventId) filter.eventId = new Types.ObjectId(query.eventId);
    else if (scopedEventIds) filter.eventId = { $in: scopedEventIds };
    if (query.zoneId) filter.zoneId = new Types.ObjectId(query.zoneId);
    if (query.areaId) filter.areaId = new Types.ObjectId(query.areaId);
    if (query.userId) filter.userId = new Types.ObjectId(query.userId);
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
      { $project: { qrCode: 0 } },
      {
        $lookup: {
          from: "events",
          localField: "eventId",
          foreignField: "_id",
          as: "eventId",
          pipeline: [{ $project: { title: 1, startDate: 1 } }],
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
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "userId",
          pipeline: [{ $project: { email: 1, name: 1 } }],
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "checkedInBy",
          foreignField: "_id",
          as: "checkedInBy",
          pipeline: [{ $project: { email: 1, name: 1 } }],
        },
      },
      {
        $lookup: {
          from: "users",
          localField: "cancelledBy",
          foreignField: "_id",
          as: "cancelledBy",
          pipeline: [{ $project: { email: 1, name: 1 } }],
        },
      },
      {
        $addFields: {
          eventId: { $ifNull: [{ $arrayElemAt: ["$eventId", 0] }, null] },
          bookingId: { $ifNull: [{ $arrayElemAt: ["$bookingId", 0] }, null] },
          zoneId: { $ifNull: [{ $arrayElemAt: ["$zoneId", 0] }, null] },
          areaId: { $ifNull: [{ $arrayElemAt: ["$areaId", 0] }, null] },
          userId: { $ifNull: [{ $arrayElemAt: ["$userId", 0] }, null] },
          checkedInBy: {
            $ifNull: [{ $arrayElemAt: ["$checkedInBy", 0] }, null],
          },
          cancelledBy: {
            $ifNull: [{ $arrayElemAt: ["$cancelledBy", 0] }, null],
          },
        },
      },
    ];
  }
}
