import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { Promotion } from "@src/schemas/promotion.schema";
import { FilterQuery, Model } from "mongoose";
import { QueryPromotionDto } from "../dto/query-promotion.dto";
import { PromotionPolicyService } from "../domain/policies/promotion-policy.service";
import { PromotionDocument } from "../domain/types/promotion-domain.types";
import { PromotionPresenter } from "../promotion.presenter";
import { PromotionDetail, PromotionListResult } from "../types/promotion.types";

@Injectable()
export class PromotionQueryService {
  constructor(
    @InjectModel(Promotion.name)
    private readonly promotionModel: Model<Promotion>,
    private readonly policy: PromotionPolicyService,
    private readonly presenter: PromotionPresenter
  ) {}

  async listPromotions(
    currentUser: JwtPayload,
    query: QueryPromotionDto
  ): Promise<PromotionListResult> {
    const filter = await this.buildListFilter(currentUser, query);
    const skip = (query.page - 1) * query.limit;
    const [rows, total] = await Promise.all([
      this.promotionModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(query.limit)
        .lean<PromotionDocument[]>(),
      this.promotionModel.countDocuments(filter),
    ]);

    return {
      items: rows.map((row) => this.presenter.toDetail(row)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async getPromotion(
    currentUser: JwtPayload,
    id: string
  ): Promise<PromotionDetail> {
    const promotion = await this.loadPromotion(id);
    await this.policy.assertCanManagePromotion(currentUser, promotion);
    return this.presenter.toDetail(promotion);
  }

  async loadPromotion(id: string): Promise<PromotionDocument> {
    const promotionId = this.policy.toObjectId(id, "Invalid promotion ID");
    const promotion = await this.promotionModel
      .findById(promotionId)
      .lean<PromotionDocument>();
    if (!promotion) {
      throw new NotFoundException("Promotion not found");
    }
    return promotion;
  }

  private async buildListFilter(
    currentUser: JwtPayload,
    query: QueryPromotionDto
  ): Promise<FilterQuery<Promotion>> {
    const filter: FilterQuery<Promotion> = {};
    if (query.code) filter.code = this.policy.normalizeCode(query.code);
    if (query.type) filter.type = query.type;
    if (query.isActive !== undefined) filter.isActive = query.isActive;
    if (query.eventId) {
      filter.eventIds = this.policy.toObjectId(
        query.eventId,
        "Invalid event ID"
      );
    }
    if (query.zoneId) {
      filter.zoneIds = this.policy.toObjectId(query.zoneId, "Invalid zone ID");
    }

    return {
      ...filter,
      ...(await this.policy.buildManagedFilter(currentUser)),
    };
  }
}
