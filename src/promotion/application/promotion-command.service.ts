import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { isDuplicateKeyError } from "@src/common/utils/mongo.utils";
import { Promotion } from "@src/schemas/promotion.schema";
import { Model, Types } from "mongoose";
import { CreatePromotionDto } from "../dto/create-promotion.dto";
import { UpdatePromotionDto } from "../dto/update-promotion.dto";
import { PromotionPolicyService } from "../domain/policies/promotion-policy.service";
import { PromotionDocument } from "../domain/types/promotion-domain.types";
import { PromotionPresenter } from "../promotion.presenter";
import {
  PromotionDetail,
  PromotionDisableResult,
} from "../types/promotion.types";
import { PromotionQueryService } from "./promotion-query.service";

@Injectable()
export class PromotionCommandService {
  constructor(
    @InjectModel(Promotion.name)
    private readonly promotionModel: Model<Promotion>,
    private readonly policy: PromotionPolicyService,
    private readonly presenter: PromotionPresenter,
    private readonly queries: PromotionQueryService
  ) {}

  async createPromotion(
    currentUser: JwtPayload,
    dto: CreatePromotionDto
  ): Promise<PromotionDetail> {
    this.policy.assertPromotionDates(dto.startsAt, dto.endsAt);
    this.policy.assertPromotionValue(dto.type, dto.value);

    const eventIds = this.policy.toObjectIds(dto.eventIds ?? [], "event ID");
    const zoneIds = this.policy.toObjectIds(dto.zoneIds ?? [], "zone ID");
    await this.policy.assertCanManageScope(currentUser, eventIds, zoneIds);

    try {
      const [created] = await this.promotionModel.create([
        {
          code: this.policy.normalizeCode(dto.code),
          type: dto.type,
          value: dto.value,
          eventIds,
          zoneIds,
          startsAt: dto.startsAt,
          endsAt: dto.endsAt,
          maxUses: dto.maxUses,
          maxUsesPerUser: dto.maxUsesPerUser,
          minOrderAmount: dto.minOrderAmount,
          isActive: dto.isActive ?? true,
          createdBy: new Types.ObjectId(currentUser.userId),
        },
      ]);
      return this.presenter.toDetail(created as PromotionDocument);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException("Promotion code already exists");
      }
      throw error;
    }
  }

  async updatePromotion(
    currentUser: JwtPayload,
    id: string,
    dto: UpdatePromotionDto
  ): Promise<PromotionDetail> {
    const existing = await this.queries.loadPromotion(id);
    await this.policy.assertCanManagePromotion(currentUser, existing);

    const nextType = dto.type ?? existing.type;
    const nextValue = dto.value ?? existing.value;
    this.policy.assertPromotionValue(nextType, nextValue);
    this.policy.assertPromotionDates(
      dto.startsAt ?? existing.startsAt,
      dto.endsAt ?? existing.endsAt
    );

    const eventIds =
      dto.eventIds === undefined
        ? existing.eventIds
        : this.policy.toObjectIds(dto.eventIds, "event ID");
    const zoneIds =
      dto.zoneIds === undefined
        ? existing.zoneIds
        : this.policy.toObjectIds(dto.zoneIds, "zone ID");
    await this.policy.assertCanManageScope(currentUser, eventIds, zoneIds);

    try {
      const updated = await this.promotionModel
        .findByIdAndUpdate(
          existing._id,
          {
            $set: {
              ...(dto.code !== undefined && {
                code: this.policy.normalizeCode(dto.code),
              }),
              ...(dto.type !== undefined && { type: dto.type }),
              ...(dto.value !== undefined && { value: dto.value }),
              ...(dto.eventIds !== undefined && { eventIds }),
              ...(dto.zoneIds !== undefined && { zoneIds }),
              ...(dto.startsAt !== undefined && { startsAt: dto.startsAt }),
              ...(dto.endsAt !== undefined && { endsAt: dto.endsAt }),
              ...(dto.maxUses !== undefined && { maxUses: dto.maxUses }),
              ...(dto.maxUsesPerUser !== undefined && {
                maxUsesPerUser: dto.maxUsesPerUser,
              }),
              ...(dto.minOrderAmount !== undefined && {
                minOrderAmount: dto.minOrderAmount,
              }),
              ...(dto.isActive !== undefined && { isActive: dto.isActive }),
              updatedBy: new Types.ObjectId(currentUser.userId),
            },
          },
          { new: true }
        )
        .lean<PromotionDocument>();

      if (!updated) {
        throw new NotFoundException("Promotion not found");
      }
      return this.presenter.toDetail(updated);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException("Promotion code already exists");
      }
      throw error;
    }
  }

  async disablePromotion(
    currentUser: JwtPayload,
    id: string
  ): Promise<PromotionDisableResult> {
    const promotion = await this.queries.loadPromotion(id);
    await this.policy.assertCanManagePromotion(currentUser, promotion);

    const updated = await this.promotionModel.findOneAndUpdate(
      { _id: promotion._id, isActive: true },
      {
        $set: {
          isActive: false,
          updatedBy: new Types.ObjectId(currentUser.userId),
        },
      },
      { new: true }
    );

    if (!updated) {
      throw new ConflictException("Promotion is already disabled");
    }

    return { id: promotion._id.toString(), isActive: false };
  }
}
