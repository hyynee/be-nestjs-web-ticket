import { Injectable, Logger } from "@nestjs/common";
import { MetricsService } from "@src/metrics/metrics.service";
import { QueueService } from "@src/queue/queue.service";
import { getPaymentErrorMessage } from "@src/payment/domain/utils/payment-error.utils";

@Injectable()
export class PaymentRefundAlertService {
  private readonly logger = new Logger(PaymentRefundAlertService.name);

  constructor(
    private readonly queueService: QueueService,
    private readonly metricsService: MetricsService
  ) {}

  async enqueueRefundFailureAlert(
    bookingId: string,
    paymentRef: string,
    source: "stripe" | "paypal",
    errorMessage: string
  ): Promise<void> {
    this.metricsService.refundFailuresTotal.inc({ source });
    try {
      await this.queueService.addJob({
        type: "refund-failure-alert",
        payload: {
          bookingId,
          paymentRef,
          source,
          errorMessage,
          occurredAt: new Date().toISOString(),
        },
      });
    } catch (alertErr) {
      this.logger.error(
        `[ALERT_ENQUEUE_FAILED] Could not enqueue refund failure alert for bookingId=${bookingId}: ${getPaymentErrorMessage(alertErr)}`
      );
    }
  }
}
