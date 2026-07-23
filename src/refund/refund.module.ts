import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import {
  RefundRequest,
  RefundRequestSchema,
} from "@src/schemas/refund-request.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { EventModule } from "@src/event/event.module";
import { PaymentModule } from "@src/payment/payment.module";
import { NotificationModule } from "@src/notification/notification.module";
import { QueueModule } from "@src/queue/queue.module";
import { ZoneModule } from "@src/zone/zone.module";
import { PromotionModule } from "@src/promotion/promotion.module";
import { CreateRefundRequestUseCase } from "./application/create-refund-request.use-case";
import { RefundQueryService } from "./application/refund-query.service";
import { ReviewRefundRequestUseCase } from "./application/review-refund-request.use-case";
import { RefundPolicyService } from "./domain/policies/refund-policy.service";
import { RefundRepository } from "./infrastructure/persistence/refund.repository";
import { RefundPresenter } from "./presenters/refund.presenter";
import { RefundController } from "./refund.controller";
import { RefundService } from "./refund.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: RefundRequest.name, schema: RefundRequestSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Payment.name, schema: PaymentSchema },
      { name: Ticket.name, schema: TicketSchema },
      { name: Zone.name, schema: ZoneSchema },
    ]),
    EventModule,
    forwardRef(() => PaymentModule),
    NotificationModule,
    QueueModule,
    ZoneModule,
    PromotionModule,
  ],
  controllers: [RefundController],
  providers: [
    RefundService,
    RefundRepository,
    RefundPresenter,
    RefundPolicyService,
    RefundQueryService,
    CreateRefundRequestUseCase,
    ReviewRefundRequestUseCase,
  ],
  exports: [RefundService],
})
export class RefundModule {}
