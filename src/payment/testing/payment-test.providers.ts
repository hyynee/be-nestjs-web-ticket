import { PaymentService } from "@src/payment/payment.service";
import { PaymentGatewayService } from "@src/payment/infrastructure/gateway/payment-gateway.service";
import { PaymentIdempotencyService } from "@src/payment/infrastructure/idempotency/payment-idempotency.service";
import { PaymentPresenter } from "@src/payment/presenters/payment.presenter";
import { CreateCheckoutSessionUseCase } from "@src/payment/application/use-case/create-checkout-session.use-case";
import { CreatePaypalTransactionUseCase } from "@src/payment/application/use-case/create-paypal-transaction.use-case";
import { GetPaymentHistoryQuery } from "@src/payment/application/use-case/get-payment-history.query";
import { CancelPaymentUseCase } from "@src/payment/application/use-case/cancel-payment.use-case";
import { IssueAdminRefundUseCase } from "@src/payment/application/use-case/issue-admin-refund.use-case";
import { HandleChargeRefundedUseCase } from "@src/payment/application/use-case/handle-charge-refunded.use-case";
import { HandleStripeSideEventUseCase } from "@src/payment/application/use-case/handle-stripe-side-event.use-case";
import { PaymentConfirmationDeliveryService } from "@src/payment/application/services/payment-confirmation-delivery.service";
import { StripePaymentSettlementService } from "@src/payment/application/services/stripe-payment-settlement.service";
import { PaypalPaymentSettlementService } from "@src/payment/application/services/paypal-payment-settlement.service";
import { PaymentSettlementOrchestrator } from "@src/payment/application/orchestrators/payment-settlement.orchestrator";
import { NotificationService } from "@src/notification/notification.service";

export const paymentTestProviders = [
  PaymentService,
  PaymentGatewayService,
  PaymentIdempotencyService,
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
  {
    provide: NotificationService,
    useValue: {
      notifyPaymentSucceeded: async () => undefined,
      notifyTicketsIssued: async () => undefined,
      queueBookingConfirmationEmail: async () => undefined,
    },
  },
];
