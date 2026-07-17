import { Injectable } from "@nestjs/common";
import { JwtPayload } from "@src/auth/dto/jwt-payload.dto";
import { ClientSession, Types } from "mongoose";
import { PromotionCommandService } from "./application/promotion-command.service";
import { PromotionQueryService } from "./application/promotion-query.service";
import { PromotionRedemptionService } from "./application/promotion-redemption.service";
import { CreatePromotionDto } from "./dto/create-promotion.dto";
import { QueryPromotionDto } from "./dto/query-promotion.dto";
import { UpdatePromotionDto } from "./dto/update-promotion.dto";
import { ValidatePromotionDto } from "./dto/validate-promotion.dto";
import type {
  PromotionApplyResult,
  PromotionBookingApplyInput,
  PromotionDetail,
  PromotionDisableResult,
  PromotionListResult,
  PromotionValidationResult,
} from "./types/promotion.types";

@Injectable()
export class PromotionService {
  constructor(
    private readonly commands: PromotionCommandService,
    private readonly queries: PromotionQueryService,
    private readonly redemption: PromotionRedemptionService
  ) {}

  createPromotion(
    currentUser: JwtPayload,
    dto: CreatePromotionDto
  ): Promise<PromotionDetail> {
    return this.commands.createPromotion(currentUser, dto);
  }

  listPromotions(
    currentUser: JwtPayload,
    query: QueryPromotionDto
  ): Promise<PromotionListResult> {
    return this.queries.listPromotions(currentUser, query);
  }

  getPromotion(currentUser: JwtPayload, id: string): Promise<PromotionDetail> {
    return this.queries.getPromotion(currentUser, id);
  }

  updatePromotion(
    currentUser: JwtPayload,
    id: string,
    dto: UpdatePromotionDto
  ): Promise<PromotionDetail> {
    return this.commands.updatePromotion(currentUser, id, dto);
  }

  disablePromotion(
    currentUser: JwtPayload,
    id: string
  ): Promise<PromotionDisableResult> {
    return this.commands.disablePromotion(currentUser, id);
  }

  validatePromotion(
    dto: ValidatePromotionDto,
    userId?: string
  ): Promise<PromotionValidationResult> {
    return this.redemption.validatePromotion(dto, userId);
  }

  applyPromotionToBooking(
    input: PromotionBookingApplyInput,
    session: ClientSession
  ): Promise<PromotionApplyResult> {
    return this.redemption.applyPromotionToBooking(input, session);
  }

  releaseUsageForBooking(
    bookingId: Types.ObjectId,
    session: ClientSession
  ): Promise<void> {
    return this.redemption.releaseUsageForBooking(bookingId, session);
  }
}
