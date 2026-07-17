import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { isDuplicateKeyError } from "@src/common/utils/mongo.utils";
import { Promotion } from "@src/schemas/promotion.schema";
import { PromotionUsage } from "@src/schemas/promotion-usage.schema";
import { ClientSession, Model, Types } from "mongoose";
import { ValidatePromotionDto } from "../dto/validate-promotion.dto";
import { PromotionPolicyService } from "../domain/policies/promotion-policy.service";
import {
  PromotionDocument,
  PromotionOrderInput,
} from "../domain/types/promotion-domain.types";
import {
  PromotionApplyResult,
  PromotionBookingApplyInput,
  PromotionValidationResult,
} from "../types/promotion.types";

@Injectable()
export class PromotionRedemptionService {
  constructor(
    @InjectModel(Promotion.name)
    private readonly promotionModel: Model<Promotion>,
    @InjectModel(PromotionUsage.name)
    private readonly promotionUsageModel: Model<PromotionUsage>,
    private readonly policy: PromotionPolicyService
  ) {}

  async validatePromotion(
    dto: ValidatePromotionDto,
    userId?: string
  ): Promise<PromotionValidationResult> {
    return this.validatePromotionForOrder({
      code: dto.code,
      eventId: dto.eventId,
      zoneId: dto.zoneId,
      orderAmount: dto.orderAmount,
      userId,
    });
  }

  async applyPromotionToBooking(
    input: PromotionBookingApplyInput,
    session: ClientSession
  ): Promise<PromotionApplyResult> {
    const quote = await this.validatePromotionForOrder(input, session);
    const promotionId = new Types.ObjectId(quote.promotionId);

    const promotion = await this.promotionModel
      .findOneAndUpdate(
        this.policy.buildAtomicUsageFilter(promotionId, quote),
        { $inc: { usedCount: 1 } },
        { new: true, session }
      )
      .lean<PromotionDocument>();

    if (!promotion) {
      throw new ConflictException("Promotion usage limit reached");
    }

    const usageOrdinal =
      (await this.promotionUsageModel
        .countDocuments({
          promotionId,
          userId: new Types.ObjectId(input.userId),
          releasedAt: { $exists: false },
        })
        .session(session)) + 1;

    try {
      const [usage] = await this.promotionUsageModel.create(
        [
          {
            promotionId,
            code: quote.code,
            userId: new Types.ObjectId(input.userId),
            bookingId: new Types.ObjectId(input.bookingId),
            discountAmount: quote.discountAmount,
            usageOrdinal,
          },
        ],
        { session }
      );

      return {
        ...quote,
        usageId: (usage._id as Types.ObjectId).toString(),
      };
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException(
          "Promotion usage changed concurrently, please retry"
        );
      }
      throw error;
    }
  }

  async releaseUsageForBooking(
    bookingId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    const usage = await this.promotionUsageModel
      .findOneAndUpdate(
        {
          bookingId,
          releasedAt: { $exists: false },
        },
        { $set: { releasedAt: new Date() } },
        { new: false, session }
      )
      .lean<{ promotionId: Types.ObjectId }>();

    if (!usage) {
      return;
    }

    await this.promotionModel.updateOne(
      { _id: usage.promotionId },
      [
        {
          $set: {
            usedCount: {
              $max: [{ $subtract: ["$usedCount", 1] }, 0],
            },
          },
        },
      ],
      { session }
    );
  }

  private async validatePromotionForOrder(
    input: PromotionOrderInput,
    session?: ClientSession
  ): Promise<PromotionValidationResult> {
    const eventId = this.policy.toObjectId(input.eventId, "Invalid event ID");
    const zoneId = this.policy.toObjectId(input.zoneId, "Invalid zone ID");
    if (!Number.isInteger(input.orderAmount) || input.orderAmount < 0) {
      throw new BadRequestException("Invalid order amount");
    }

    await this.policy.assertZoneBelongsToEvent(zoneId, eventId, session);

    const code = this.policy.normalizeCode(input.code);
    const promotion = await this.promotionModel
      .findOne({ code })
      .session(session ?? null)
      .lean<PromotionDocument>();

    if (!promotion) {
      throw new NotFoundException("Promotion not found");
    }
    this.policy.assertPromotionUsable(
      promotion,
      eventId,
      zoneId,
      input.orderAmount,
      new Date()
    );

    if (input.userId && promotion.maxUsesPerUser) {
      const usedByUser = await this.promotionUsageModel
        .countDocuments({
          promotionId: promotion._id,
          userId: new Types.ObjectId(input.userId),
          releasedAt: { $exists: false },
        })
        .session(session ?? null);
      if (usedByUser >= promotion.maxUsesPerUser) {
        throw new ConflictException("Promotion per-user usage limit reached");
      }
    }

    const discountAmount = this.policy.calculateDiscount(
      input.orderAmount,
      promotion.type,
      promotion.value
    );

    return {
      valid: true,
      promotionId: promotion._id.toString(),
      code: promotion.code,
      type: promotion.type,
      value: promotion.value,
      originalAmount: input.orderAmount,
      discountAmount,
      finalAmount: input.orderAmount - discountAmount,
    };
  }
}
