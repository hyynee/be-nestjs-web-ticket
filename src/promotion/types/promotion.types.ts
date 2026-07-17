import { PromotionType } from "@src/schemas/promotion.schema";

export interface PromotionDetail {
  id: string;
  code: string;
  type: PromotionType;
  value: number;
  eventIds: string[];
  zoneIds: string[];
  startsAt: Date;
  endsAt: Date;
  maxUses?: number;
  maxUsesPerUser?: number;
  usedCount: number;
  minOrderAmount?: number;
  isActive: boolean;
  createdBy: string;
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface PromotionListResult {
  items: PromotionDetail[];
  total: number;
  page: number;
  limit: number;
}

export interface PromotionDisableResult {
  id: string;
  isActive: false;
}

export interface PromotionValidationResult {
  valid: true;
  promotionId: string;
  code: string;
  type: PromotionType;
  value: number;
  originalAmount: number;
  discountAmount: number;
  finalAmount: number;
}

export interface PromotionApplyResult extends PromotionValidationResult {
  usageId: string;
}

export interface PromotionBookingApplyInput {
  code: string;
  userId: string;
  eventId: string;
  zoneId: string;
  bookingId: string;
  orderAmount: number;
}
