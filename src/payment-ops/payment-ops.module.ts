import { Module, forwardRef } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import {
  PaymentWebhookEvent,
  PaymentWebhookEventSchema,
} from "@src/schemas/payment-webhook-event.schema";
import { PaymentModule } from "@src/payment/payment.module";
import { PaymentWebhookDispatcherService } from "./application/payment-webhook-dispatcher.service";
import { PaymentWebhookQueryService } from "./application/payment-webhook-query.service";
import { PaymentWebhookRecorderService } from "./application/payment-webhook-recorder.service";
import { PaymentWebhookStateService } from "./application/payment-webhook-state.service";
import { RetryWebhookEventUseCase } from "./application/retry-webhook-event.use-case";
import { PaymentWebhookEventRepository } from "./infrastructure/persistence/payment-webhook-event.repository";
import { PaymentOpsController } from "./payment-ops.controller";
import { PaymentOpsService } from "./payment-ops.service";
import { PaymentWebhookEventPresenter } from "./presenters/payment-webhook-event.presenter";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: PaymentWebhookEvent.name, schema: PaymentWebhookEventSchema },
    ]),
    forwardRef(() => PaymentModule),
  ],
  controllers: [PaymentOpsController],
  providers: [
    PaymentOpsService,
    PaymentWebhookEventRepository,
    PaymentWebhookEventPresenter,
    PaymentWebhookRecorderService,
    PaymentWebhookStateService,
    PaymentWebhookQueryService,
    PaymentWebhookDispatcherService,
    RetryWebhookEventUseCase,
  ],
  exports: [PaymentOpsService],
})
export class PaymentOpsModule {}
