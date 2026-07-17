import { Injectable } from "@nestjs/common";
import { Types } from "mongoose";
import { Promotion } from "@src/schemas/promotion.schema";
import { PromotionDetail } from "./types/promotion.types";

type PromotionSource = Promotion & {
  _id?: Types.ObjectId | string;
  createdAt?: Date;
  updatedAt?: Date;
};

@Injectable()
export class PromotionPresenter {
  toDetail(promotion: PromotionSource): PromotionDetail {
    return {
      id: promotion._id?.toString() ?? "",
      code: promotion.code,
      type: promotion.type,
      value: promotion.value,
      eventIds: (promotion.eventIds ?? []).map((id) => id.toString()),
      zoneIds: (promotion.zoneIds ?? []).map((id) => id.toString()),
      startsAt: promotion.startsAt,
      endsAt: promotion.endsAt,
      maxUses: promotion.maxUses,
      maxUsesPerUser: promotion.maxUsesPerUser,
      usedCount: promotion.usedCount,
      minOrderAmount: promotion.minOrderAmount,
      isActive: promotion.isActive,
      createdBy: promotion.createdBy.toString(),
      updatedBy: promotion.updatedBy?.toString(),
      createdAt: promotion.createdAt,
      updatedAt: promotion.updatedAt,
    };
  }
}
