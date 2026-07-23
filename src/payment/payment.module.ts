import { Module, forwardRef } from "@nestjs/common";
import { PaymentService } from "./payment.service";
import { PaymentController } from "./payment.controller";
import { PaymentScheduler } from "./payment.scheduler";
import { MongooseModule } from "@nestjs/mongoose";
import { Booking, BookingSchema } from "@src/schemas/booking.schema";
import { Payment, PaymentSchema } from "@src/schemas/payment.schema";
import { Zone, ZoneSchema } from "@src/schemas/zone.schema";
import { Ticket, TicketSchema } from "@src/schemas/ticket.schema";
import { TicketModule } from "@src/ticket/ticket.module";
import { MailModule } from "@src/services/mail.module";
import { ZoneModule } from "@src/zone/zone.module";
import { EventsModule } from "@src/events/events.module";
import { QueueModule } from "@src/queue/queue.module";
import { PaymentGatewayService } from "./infrastructure/gateway/payment-gateway.service";
import { PaymentIdempotencyService } from "./infrastructure/idempotency/payment-idempotency.service";
import { PaymentRefundAlertService } from "./infrastructure/alerts/payment-refund-alert.service";
import { PaymentPresenter } from "./presenters/payment.presenter";
import { CreateCheckoutSessionUseCase } from "./application/use-case/create-checkout-session.use-case";
import { CreatePaypalTransactionUseCase } from "./application/use-case/create-paypal-transaction.use-case";
import { GetPaymentHistoryQuery } from "./application/use-case/get-payment-history.query";
import { CancelPaymentUseCase } from "./application/use-case/cancel-payment.use-case";
import { IssueAdminRefundUseCase } from "./application/use-case/issue-admin-refund.use-case";
import { HandleChargeRefundedUseCase } from "./application/use-case/handle-charge-refunded.use-case";
import { HandleStripeSideEventUseCase } from "./application/use-case/handle-stripe-side-event.use-case";
import { PaymentSettlementOrchestrator } from "./application/orchestrators/payment-settlement.orchestrator";
import { PaymentConfirmationDeliveryService } from "./application/services/payment-confirmation-delivery.service";
import { StripePaymentSettlementService } from "./application/services/stripe-payment-settlement.service";
import { PaypalPaymentSettlementService } from "./application/services/paypal-payment-settlement.service";
import { PaymentOpsModule } from "@src/payment-ops/payment-ops.module";
import { NotificationModule } from "@src/notification/notification.module";
import { PromotionModule } from "@src/promotion/promotion.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Payment.name, schema: PaymentSchema },
      { name: Booking.name, schema: BookingSchema },
      { name: Zone.name, schema: ZoneSchema },
      { name: Ticket.name, schema: TicketSchema },
    ]),
    TicketModule,
    MailModule,
    ZoneModule,
    EventsModule,
    QueueModule,
    NotificationModule,
    PromotionModule,
    forwardRef(() => PaymentOpsModule),
  ],
  controllers: [PaymentController],
  providers: [
    PaymentService,
    PaymentScheduler,
    PaymentGatewayService,
    PaymentIdempotencyService,
    PaymentRefundAlertService,
    PaymentPresenter,
    CreateCheckoutSessionUseCase,
    CreatePaypalTransactionUseCase,
    GetPaymentHistoryQuery,
    CancelPaymentUseCase,
    IssueAdminRefundUseCase,
    HandleChargeRefundedUseCase,
    HandleStripeSideEventUseCase,
    PaymentConfirmationDeliveryService,
    StripePaymentSettlementService,
    PaypalPaymentSettlementService,
    PaymentSettlementOrchestrator,
  ],
  exports: [PaymentService],
})
export class PaymentModule {}
