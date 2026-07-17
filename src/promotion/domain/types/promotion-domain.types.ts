import { Promotion } from "@src/schemas/promotion.schema";
import { Types } from "mongoose";

export type PromotionDocument = Promotion & {
  _id: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
};

export type ZoneScope = {
  _id: Types.ObjectId;
  eventId: Types.ObjectId;
};

export type PromotionOrderInput = {
  code: string;
  eventId: string;
  zoneId: string;
  orderAmount: number;
  userId?: string;
};
