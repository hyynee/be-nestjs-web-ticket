import { Injectable } from "@nestjs/common";
import { FilterQuery } from "mongoose";
import {
  PaymentWebhookEvent,
  PaymentWebhookProvider,
} from "@src/schemas/payment-webhook-event.schema";
import { QueryWebhookEventDto } from "../dto/query-webhook-event.dto";
import { PaymentWebhookEventRepository } from "../infrastructure/persistence/payment-webhook-event.repository";
import { PaymentWebhookEventPresenter } from "../presenters/payment-webhook-event.presenter";
import type {
  PaymentWebhookEventDetail,
  PaymentWebhookEventListResult,
} from "../types/payment-ops.types";

@Injectable()
export class PaymentWebhookQueryService {
  constructor(
    private readonly repository: PaymentWebhookEventRepository,
    private readonly presenter: PaymentWebhookEventPresenter
  ) {}

  async findAll(
    query: QueryWebhookEventDto
  ): Promise<PaymentWebhookEventListResult> {
    const filter = this.buildListFilter(query);
    const { rows, total } = await this.repository.findMany(
      filter,
      query.page,
      query.limit
    );

    return {
      items: rows.map((row) => this.presenter.toListItem(row)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async findById(id: string): Promise<PaymentWebhookEventDetail> {
    const row = await this.repository.loadById(id);
    return this.presenter.toDetail(row);
  }

  private buildListFilter(
    query: QueryWebhookEventDto
  ): FilterQuery<PaymentWebhookEvent> {
    const filter: FilterQuery<PaymentWebhookEvent> = {};

    if (query.provider) filter.provider = query.provider;
    if (query.status) filter.status = query.status;
    if (query.eventType) filter.eventType = query.eventType;

    if (query.from || query.to) {
      filter.createdAt = {
        ...(query.from ? { $gte: new Date(query.from) } : {}),
        ...(query.to ? { $lte: new Date(query.to) } : {}),
      };
    }

    if (filter.provider === PaymentWebhookProvider.PAYPAL) {
      return filter;
    }

    return filter;
  }
}
