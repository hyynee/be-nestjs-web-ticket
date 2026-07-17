import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { RefundRequest } from "@src/schemas/refund-request.schema";
import { FilterQuery, Types } from "mongoose";
import { QueryRefundRequestDto } from "../dto/query-refund-request.dto";
import { RefundPolicyService } from "../domain/policies/refund-policy.service";
import { RefundRepository } from "../infrastructure/persistence/refund.repository";
import { RefundPresenter } from "../presenters/refund.presenter";
import type {
  RefundRequestDetail,
  RefundRequestListResult,
} from "../types/refund.types";

@Injectable()
export class RefundQueryService {
  constructor(
    private readonly repository: RefundRepository,
    private readonly presenter: RefundPresenter,
    private readonly policy: RefundPolicyService,
    private readonly eventOwnershipService: EventOwnershipService
  ) {}

  async listMyRefundRequests(
    user: JwtPayload,
    query: QueryRefundRequestDto
  ): Promise<RefundRequestListResult> {
    const filter = this.buildListFilter(query);
    filter.userId = new Types.ObjectId(user.userId);
    return this.findMany(filter, query.page, query.limit);
  }

  async getMyRefundRequest(
    user: JwtPayload,
    id: string
  ): Promise<RefundRequestDetail> {
    const request = await this.repository.loadRequestById(id);
    this.policy.assertViewOwner(user, request);
    return this.presenter.toDetail(request);
  }

  async listRefundRequests(
    user: JwtPayload,
    query: QueryRefundRequestDto
  ): Promise<RefundRequestListResult> {
    const filter = this.buildListFilter(query);
    if (user.role !== "admin") {
      const eventIds =
        await this.eventOwnershipService.getManagedEventIds(user);
      if (eventIds.length === 0) {
        return { items: [], total: 0, page: query.page, limit: query.limit };
      }
      filter.eventId = { $in: eventIds };
    }
    return this.findMany(filter, query.page, query.limit);
  }

  async getRefundRequest(
    user: JwtPayload,
    id: string
  ): Promise<RefundRequestDetail> {
    const request = await this.repository.loadRequestById(id);
    await this.policy.assertCanReview(user, request.eventId.toString());
    return this.presenter.toDetail(request);
  }

  private async findMany(
    filter: FilterQuery<RefundRequest>,
    page: number,
    limit: number
  ): Promise<RefundRequestListResult> {
    const { rows, total } = await this.repository.findMany(filter, page, limit);
    return {
      items: rows.map((row) => this.presenter.toDetail(row)),
      total,
      page,
      limit,
    };
  }

  private buildListFilter(
    query: QueryRefundRequestDto
  ): FilterQuery<RefundRequest> {
    const filter: FilterQuery<RefundRequest> = { isDeleted: false };
    if (query.status) filter.status = query.status;
    if (query.eventId) filter.eventId = new Types.ObjectId(query.eventId);
    if (query.bookingId) filter.bookingId = new Types.ObjectId(query.bookingId);
    if (query.userId) filter.userId = new Types.ObjectId(query.userId);
    return filter;
  }
}
