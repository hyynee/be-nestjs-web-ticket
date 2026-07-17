import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { EventOwnershipService } from "@src/event/event-ownership.service";
import { Event, EventSchema } from "@src/schemas/event.schema";
import { Promotion, PromotionSchema } from "@src/schemas/promotion.schema";
import {
  PromotionUsage,
  PromotionUsageSchema,
} from "@src/schemas/promotion-usage.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { PromotionCommandService } from "./application/promotion-command.service";
import { PromotionQueryService } from "./application/promotion-query.service";
import { PromotionRedemptionService } from "./application/promotion-redemption.service";
import { PromotionPolicyService } from "./domain/policies/promotion-policy.service";
import { PromotionController } from "./promotion.controller";
import { PromotionPresenter } from "./promotion.presenter";
import { PromotionService } from "./promotion.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Promotion.name, schema: PromotionSchema },
      { name: PromotionUsage.name, schema: PromotionUsageSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Event.name, schema: EventSchema },
    ]),
  ],
  controllers: [PromotionController],
  providers: [
    PromotionService,
    PromotionCommandService,
    PromotionQueryService,
    PromotionRedemptionService,
    PromotionPolicyService,
    PromotionPresenter,
    EventOwnershipService,
  ],
  exports: [PromotionService],
})
export class PromotionModule {}
